// src/catalog-intelligence/services/data-quality.service.ts  v5.0.0
//
// runBatchScoring reads from store.products (source of truth) joined with
// catalog.products (for LTREE taxonomy_path + family lookup via <@ operator).
// cil.product_quality uses asin TEXT PK — no FK to catalog.products,
// intentionally, so quality scoring can run independently.

import { Injectable, Logger } from '@nestjs/common'
import { NeonService }        from './neon.service'
import type {
  BatchCursor, EnrichmentJobResult, ParsedProductDetails, ProductQualityScore, QualityIssue,
} from '../types/cil.types'

const DIMENSION_WEIGHTS = {
  title:       0.25, images:      0.20, description: 0.15,
  attributes:  0.20, variants:    0.10, reviews:     0.05, taxonomy:    0.05,
} as const

const ISSUE = {
  TITLE_TOO_SHORT:'TITLE_TOO_SHORT', TITLE_TOO_LONG:'TITLE_TOO_LONG',
  TITLE_ALL_CAPS: 'TITLE_ALL_CAPS',  TITLE_NO_BRAND:'TITLE_NO_BRAND',
  NO_IMAGES:      'NO_IMAGES',       NO_MAIN_IMAGE: 'NO_MAIN_IMAGE',
  FEW_IMAGES:     'FEW_IMAGES',      NO_DESCRIPTION:'NO_DESCRIPTION',
  SHORT_DESC:     'SHORT_DESCRIPTION', LOW_ATTR_COV: 'LOW_ATTR_COVERAGE',
  NO_VARIANTS:    'NO_VARIANTS',     FEW_REVIEWS:   'FEW_REVIEWS',
  LOW_RATING:     'LOW_RATING',      NO_TAXONOMY:   'NO_TAXONOMY',
  SHALLOW_TAX:    'SHALLOW_TAXONOMY',
} as const

@Injectable()
export class DataQualityService {
  private readonly logger = new Logger(DataQualityService.name)
  constructor(private readonly neon: NeonService) {}

  // ── Public sync scorer (no DB) ────────────────────────────────────────────

  scoreProduct(
    rawJson:       Record<string, unknown>,
    familySchema:  { key: string; required: boolean }[] = [],
    taxonomyDepth: number = 1,
  ): Omit<ProductQualityScore, 'asin' | 'productId' | 'scoredAt' | 'needsRescore'> {
    const issues: QualityIssue[] = []
    const data = (rawJson['data'] ?? rawJson) as Record<string, unknown>
    const pr   = (data['product_results'] ?? {}) as Record<string, unknown>
    const pd   = (data['product_details']  ?? {}) as Record<string, unknown>

    const titleScore   = this.scoreTitle(pr, issues)
    const imagesScore  = this.scoreImages(pr, issues)
    const descScore    = this.scoreDescription(data, issues)
    const { score: attrsScore, missingAttrs, presentAttrs, coverage } =
      this.scoreAttributes(pd, familySchema, issues)
    const variantsScore = this.scoreVariants(pr, issues)
    const reviewsScore  = this.scoreReviews(pr, issues)
    const taxonomyScore = this.scoreTaxonomy(taxonomyDepth, issues)

    const overall = Math.round(
      titleScore    * DIMENSION_WEIGHTS.title       +
      imagesScore   * DIMENSION_WEIGHTS.images      +
      descScore     * DIMENSION_WEIGHTS.description +
      attrsScore    * DIMENSION_WEIGHTS.attributes  +
      variantsScore * DIMENSION_WEIGHTS.variants    +
      reviewsScore  * DIMENSION_WEIGHTS.reviews     +
      taxonomyScore * DIMENSION_WEIGHTS.taxonomy,
    )

    return {
      qualityScore:    Math.max(0, Math.min(100, overall)),
      scoreDimensions: { title: titleScore, images: imagesScore, description: descScore,
        attributes: attrsScore, variants: variantsScore, reviews: reviewsScore, taxonomy: taxonomyScore },
      issues, missingAttrs, presentAttrs, attributeCoverage: coverage,
    }
  }

  // ── Batch scoring pipeline ────────────────────────────────────────────────

  async runBatchScoring(cursor: BatchCursor): Promise<EnrichmentJobResult> {
    const pool      = this.neon.getPool()
    const jobId     = cursor.jobId
    const batchSize = Math.max(1, Math.min(cursor.batchSize, 200))

    // Load family schemas keyed by LTREE path (text representation)
    const familySchemas = await this.loadFamilySchemas()

    let lastAsin  = cursor.lastAsin
    let processed = 0, failed = 0, skipped = 0, keepGoing = true

    await this.markJobRunning(pool, jobId)

    try {
      while (keepGoing) {
        // Join store.products with catalog.products to get LTREE taxonomy_path.
        // catalog.products is auto-synced from store.products via DB trigger.
        const batch = await pool.query<{
          asin:           string
          taxonomy_path:  string | null   // LTREE returned as text
          taxonomy_depth: number
          pr_json:        Record<string, unknown>
          pd_json:        Record<string, unknown>
          thumbnails_ct:  number
        }>(
          `SELECT sp.asin,
                  cp.taxonomy_path::text               AS taxonomy_path,
                  COALESCE(nlevel(cp.taxonomy_path),1) AS taxonomy_depth,
                  sp.product_results                   AS pr_json,
                  sp.product_details                   AS pd_json,
                  COALESCE(array_length(sp.thumbnails,1), 0) AS thumbnails_ct
           FROM   store.products sp
           LEFT   JOIN catalog.products cp ON cp.asin = sp.asin
           WHERE  sp.is_active = true
             AND  ($1::text IS NULL OR sp.asin > $1)
           ORDER  BY sp.asin ASC
           LIMIT  $2`,
          [lastAsin, batchSize],
        )

        if (!batch.rowCount || batch.rows.length === 0) { keepGoing = false; break }

        for (const row of batch.rows) {
          try {
            const taxPath  = row.taxonomy_path ?? ''
            const depth    = row.taxonomy_depth ?? 1
            const schema   = familySchemas.get(taxPath) ?? []

            // Build raw_json shape scoreProduct() expects
            const prJson = row.pr_json ?? {}
            // Inject DB thumbnail count (more accurate than JSONB field)
            if (row.thumbnails_ct > 0) {
              (prJson as any)['_thumbnails_count'] = row.thumbnails_ct
            }

            const rawJson: Record<string, unknown> = {
              data: { product_results: prJson, product_details: row.pd_json ?? {} },
            }

            const sr = this.scoreProduct(rawJson, schema, depth)

            await pool.query(
              `INSERT INTO cil.product_quality
                (asin, quality_score,
                 score_title, score_images, score_description,
                 score_attributes, score_variants, score_reviews, score_taxonomy,
                 issues, missing_attrs, present_attrs, attribute_coverage,
                 pipeline_version, scored_at, needs_rescore)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'v1',NOW(),false)
               ON CONFLICT (asin) DO UPDATE SET
                 quality_score=EXCLUDED.quality_score,
                 score_title=EXCLUDED.score_title, score_images=EXCLUDED.score_images,
                 score_description=EXCLUDED.score_description,
                 score_attributes=EXCLUDED.score_attributes,
                 score_variants=EXCLUDED.score_variants, score_reviews=EXCLUDED.score_reviews,
                 score_taxonomy=EXCLUDED.score_taxonomy,
                 issues=EXCLUDED.issues, missing_attrs=EXCLUDED.missing_attrs,
                 present_attrs=EXCLUDED.present_attrs, attribute_coverage=EXCLUDED.attribute_coverage,
                 pipeline_version=EXCLUDED.pipeline_version, scored_at=EXCLUDED.scored_at,
                 needs_rescore=false, updated_at=NOW()`,
              [
                row.asin, sr.qualityScore,
                sr.scoreDimensions.title, sr.scoreDimensions.images,
                sr.scoreDimensions.description, sr.scoreDimensions.attributes,
                sr.scoreDimensions.variants, sr.scoreDimensions.reviews,
                sr.scoreDimensions.taxonomy,
                JSON.stringify(sr.issues), sr.missingAttrs, sr.presentAttrs, sr.attributeCoverage,
              ],
            )

            processed++; lastAsin = row.asin
          } catch (err) {
            failed++
            this.logger.warn(`Quality score failed ASIN=${row.asin}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        await pool.query(
          `UPDATE cil.enrichment_jobs SET processed_items=$1, failed_items=$2, last_processed_asin=$3 WHERE id=$4`,
          [processed, failed, lastAsin, jobId],
        )

        if (batch.rows.length < batchSize) { keepGoing = false }
      }
    } catch (err) {
      await this.markJobFailed(pool, jobId, err instanceof Error ? err.message : String(err))
      throw err
    }

    const total = processed + failed + skipped
    await this.markJobCompleted(pool, jobId, processed, failed, total)

    return {
      jobId, jobType: 'quality_scoring', status: 'completed',
      processedItems: processed, failedItems: failed, skippedItems: skipped, totalItems: total,
      lastProcessedAsin: lastAsin,
      results: { avgScoreUpdate: 'see cil.product_quality' },
      startedAt: null, completedAt: new Date(),
    }
  }

  // ── Scoring dimensions ────────────────────────────────────────────────────

  private scoreTitle(pr: Record<string, unknown>, issues: QualityIssue[]): number {
    const title = typeof pr['title'] === 'string' ? pr['title'].trim() : ''
    const brand = typeof pr['brand'] === 'string' ? pr['brand'].trim() : ''
    if (!title) return 0
    let s = 100
    if (title.length < 30)  { s -= 40; issues.push({ code: ISSUE.TITLE_TOO_SHORT, severity:'critical', message:`Title is ${title.length} chars (min 30)`, field:'title' }) }
    else if (title.length < 60)  { s -= 20 }
    else if (title.length > 250) { s -= 15; issues.push({ code: ISSUE.TITLE_TOO_LONG, severity:'warning', message:`Title is ${title.length} chars (max 250)`, field:'title' }) }
    const upperRatio = (title.match(/[A-Z]/g)?.length ?? 0) / title.length
    if (upperRatio > 0.6 && title.length > 20) { s -= 20; issues.push({ code: ISSUE.TITLE_ALL_CAPS, severity:'warning', message:'Title appears to be ALL CAPS', field:'title' }) }
    if (brand && !title.toLowerCase().includes(brand.toLowerCase())) { s -= 10; issues.push({ code: ISSUE.TITLE_NO_BRAND, severity:'info', message:'Brand not mentioned in title', field:'title' }) }
    return Math.max(0, s)
  }

  private scoreImages(pr: Record<string, unknown>, issues: QualityIssue[]): number {
    const thumb = typeof pr['thumbnail'] === 'string' ? pr['thumbnail'] : ''
    const count = (pr['_thumbnails_count'] as number) ||
      (Array.isArray(pr['thumbnails']) ? (pr['thumbnails'] as string[]).filter(t => t.startsWith('http')).length : 0)
    if (!thumb && count === 0) { issues.push({ code: ISSUE.NO_IMAGES, severity:'critical', message:'No images', field:'thumbnail' }); return 0 }
    if (!thumb) issues.push({ code: ISSUE.NO_MAIN_IMAGE, severity:'critical', message:'No main thumbnail', field:'thumbnail' })
    let s = 100
    if (count === 0) { s = 10 }
    else if (count === 1) { s -= 40; issues.push({ code: ISSUE.FEW_IMAGES, severity:'warning', message:'Only 1 image (6+ recommended)', field:'thumbnails' }) }
    else if (count < 4)  { s -= 20; issues.push({ code: ISSUE.FEW_IMAGES, severity:'warning', message:`Only ${count} images`, field:'thumbnails' }) }
    else if (count < 6)  { s -= 10 }
    return Math.max(0, s)
  }

  private scoreDescription(data: Record<string, unknown>, issues: QualityIssue[]): number {
    const about = Array.isArray(data['about_item']) ? data['about_item'] as unknown[] : []
    if (about.length === 0) { issues.push({ code: ISSUE.NO_DESCRIPTION, severity:'critical', message:'No description bullets', field:'about_item' }); return 0 }
    let s = 100
    if (about.length < 3)  { s -= 30; issues.push({ code: ISSUE.SHORT_DESC, severity:'warning', message:`Only ${about.length} bullet(s)`, field:'about_item' }) }
    else if (about.length < 5) { s -= 15 }
    return Math.max(0, s)
  }

  private scoreAttributes(
    pd: Record<string, unknown>, familySchema: { key: string; required: boolean }[], issues: QualityIssue[],
  ): { score: number; missingAttrs: string[]; presentAttrs: string[]; coverage: number } {
    const presentAttrs = Object.keys(pd).filter(k => pd[k] !== null && pd[k] !== undefined && pd[k] !== '')
    if (familySchema.length === 0) return { score: presentAttrs.length > 0 ? 70 : 40, missingAttrs:[], presentAttrs, coverage:0 }
    const presentSet   = new Set(presentAttrs)
    const required     = familySchema.filter(s => s.required)
    const missingAttrs = required.filter(s => !presentSet.has(s.key)).map(s => s.key)
    const coverage     = Math.round((presentAttrs.filter(k => familySchema.some(s => s.key === k)).length / familySchema.length) * 100)
    let s = 100
    if (missingAttrs.length > 0) { s -= Math.min(60, missingAttrs.length * 10); issues.push({ code: ISSUE.LOW_ATTR_COV, severity:'warning', message:`Missing ${missingAttrs.length} required attributes`, field:'product_details' }) }
    if (coverage < 40) s -= 20
    return { score: Math.max(0, s), missingAttrs, presentAttrs, coverage }
  }

  private scoreVariants(pr: Record<string, unknown>, issues: QualityIssue[]): number {
    const v = Array.isArray(pr['variants']) ? pr['variants'] as unknown[] : []
    if (v.length === 0) { issues.push({ code: ISSUE.NO_VARIANTS, severity:'info', message:'No variants found', field:'variants' }); return 50 }
    return 100
  }

  private scoreReviews(pr: Record<string, unknown>, issues: QualityIssue[]): number {
    const count  = Number(pr['reviews'] ?? 0)
    const rating = Number(pr['rating']  ?? 0)
    let s = 100
    if (count < 10)  { s -= 50; issues.push({ code: ISSUE.FEW_REVIEWS, severity:'warning', message:`Only ${count} reviews`, field:'reviews' }) }
    else if (count < 50) { s -= 25 }
    if (rating > 0 && rating < 3.5) { s -= 30; issues.push({ code: ISSUE.LOW_RATING, severity:'warning', message:`Low rating: ${rating}`, field:'rating' }) }
    return Math.max(0, s)
  }

  private scoreTaxonomy(depth: number, issues: QualityIssue[]): number {
    if (depth === 0) { issues.push({ code: ISSUE.NO_TAXONOMY, severity:'critical', message:'No taxonomy', field:'taxonomy' }); return 0 }
    if (depth === 1) { issues.push({ code: ISSUE.SHALLOW_TAX, severity:'warning', message:'No subcategory', field:'taxonomy' }); return 60 }
    return 100
  }

  // Load all active family schemas keyed by LTREE path string
  private async loadFamilySchemas(): Promise<Map<string, { key: string; required: boolean }[]>> {
    const rows = await this.neon.query<{ taxonomy_path: string; attribute_schema: unknown }>(
      `SELECT taxonomy_path::text AS taxonomy_path, attribute_schema
       FROM cil.attribute_families WHERE is_active = true`,
    )
    const map = new Map<string, { key: string; required: boolean }[]>()
    for (const row of rows) {
      const schema = Array.isArray(row.attribute_schema) ? row.attribute_schema as { key: string; required: boolean }[] : []
      map.set(row.taxonomy_path, schema)
    }
    return map
  }

  private async markJobRunning(pool: any, jobId: string): Promise<void> {
    await pool.query(`UPDATE cil.enrichment_jobs SET status='running', started_at=NOW() WHERE id=$1`, [jobId]).catch(() => void 0)
  }
  private async markJobCompleted(pool: any, jobId: string, p: number, f: number, t: number): Promise<void> {
    await pool.query(
      `UPDATE cil.enrichment_jobs SET status='completed', completed_at=NOW(), processed_items=$2, failed_items=$3, total_items=$4 WHERE id=$1`,
      [jobId, p, f, t],
    ).catch((err: Error) => this.logger.warn(`markJobCompleted failed: ${err.message}`))
  }
  private async markJobFailed(pool: any, jobId: string, error: string): Promise<void> {
    await pool.query(
      `UPDATE cil.enrichment_jobs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
      [jobId, error.slice(0, 1000)],
    ).catch(() => void 0)
  }
}
