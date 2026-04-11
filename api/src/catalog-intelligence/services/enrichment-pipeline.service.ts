// src/catalog-intelligence/services/enrichment-pipeline.service.ts  v5.0.0
//
// Accordion job reads from store.products (product_details JSONB).
// It skips products already in catalog.product_accordion.
// Output goes to catalog.product_accordion (keyed by asin).
//
// Also writes to catalog.product_attributes (partitioned EAV) so that
// cil.attribute_families.refreshSchema() can use proper LTREE <@ queries
// after the first accordion run.

import { Injectable, Logger } from '@nestjs/common'
import { v4 as uuidv4 }       from 'uuid'
import { NeonService }                from './neon.service'
import { AttributeIntelligenceService } from './attribute-intelligence.service'
import { DataQualityService }         from './data-quality.service'
import type {
  AccordionGroup, BatchCursor, EnrichmentJobResult, EnrichmentJobType, ParsedProductDetails,
} from '../types/cil.types'

const MAX_BATCH_SIZE = 500

function clampBatch(n: number | undefined | null): number {
  const v = typeof n === 'number' && isFinite(n) ? n : 100
  return Math.max(1, Math.min(v, MAX_BATCH_SIZE))
}

function rowToJobResult(row: Record<string, unknown>): EnrichmentJobResult {
  return {
    jobId:             String(row['id'] ?? ''),
    jobType:           (row['job_type'] as EnrichmentJobType) ?? 'quality_scoring',
    status:            String(row['status'] ?? 'pending') as EnrichmentJobResult['status'],
    processedItems:    Number(row['processed_items'] ?? 0),
    failedItems:       Number(row['failed_items'] ?? 0),
    skippedItems:      Number(row['skipped_items'] ?? 0),
    totalItems:        Number(row['total_items'] ?? 0),
    lastProcessedAsin: typeof row['last_processed_asin'] === 'string' ? row['last_processed_asin'] : null,
    results:           typeof row['results'] === 'object' && row['results'] !== null
                         ? row['results'] as Record<string, unknown> : {},
    startedAt:  row['started_at']   instanceof Date ? row['started_at']   : null,
    completedAt: row['completed_at'] instanceof Date ? row['completed_at'] : null,
  }
}

@Injectable()
export class EnrichmentPipelineService {
  private readonly logger = new Logger(EnrichmentPipelineService.name)

  constructor(
    private readonly neon:         NeonService,
    private readonly intelligence: AttributeIntelligenceService,
    private readonly quality:      DataQualityService,
  ) {}

  // ════════════════════════════════════════════════════════════════════════════
  // ACCORDION GENERATION
  //
  // Reads store.products.product_details (JSONB) for products not yet in
  // catalog.product_accordion. Uses catalog.products for LTREE taxonomy_path
  // (synced automatically by DB trigger on store.products INSERT).
  //
  // Output:
  //   catalog.product_accordion  (asin → [{group,icon,attributes}])
  //   catalog.product_attributes (EAV rows, partitioned by taxonomy_depth)
  // ════════════════════════════════════════════════════════════════════════════

  async runAccordionGeneration(
    batchSize:      number = 100,
    resumeFromAsin: string | null = null,
  ): Promise<EnrichmentJobResult> {
    const safeBatch = clampBatch(batchSize)
    const jobId     = uuidv4()
    let lastAsin    = resumeFromAsin
    let processed   = 0
    let failed      = 0

    await this.neon.query(
      `INSERT INTO cil.enrichment_jobs
         (id, job_type, status, config, last_processed_asin, started_at)
       VALUES ($1,'accordion_generation','running',$2,$3,NOW())`,
      [jobId, JSON.stringify({ batchSize: safeBatch }), lastAsin],
    )

    try {
      while (true) {
        // Join store.products + catalog.products to get both the JSONB blob
        // and the LTREE taxonomy_path in one query.
        // LEFT JOIN catalog.product_accordion to skip already-processed products.
        const rows = await this.neon.query<{
          asin:            string
          title:           string
          taxonomy_path:   string | null   // LTREE returned as text
          taxonomy_depth:  number
          product_details: string | null   // JSONB::text
        }>(
          `SELECT sp.asin,
                  sp.title,
                  cp.taxonomy_path::text      AS taxonomy_path,
                  COALESCE(nlevel(cp.taxonomy_path), 1) AS taxonomy_depth,
                  sp.product_details::text    AS product_details
           FROM   store.products sp
           LEFT   JOIN catalog.products cp ON cp.asin = sp.asin
           LEFT   JOIN catalog.product_accordion pa ON pa.asin = sp.asin
           WHERE  sp.is_active = true
             AND  pa.asin IS NULL
             AND  ($1::text IS NULL OR sp.asin > $1)
           ORDER  BY sp.asin ASC
           LIMIT  $2`,
          [lastAsin, safeBatch],
        )

        if (rows.length === 0) break

        for (const row of rows) {
          try {
            const pd: ParsedProductDetails = this.parseProductDetails(row.product_details)

            const accordion = await this.intelligence.generateAccordion(
              row.asin, row.title ?? '', pd,
            )

            // Write to catalog.product_accordion
            await this.neon.query(
              `INSERT INTO catalog.product_accordion (asin, content)
               VALUES ($1, $2::jsonb)
               ON CONFLICT (asin) DO UPDATE SET content=EXCLUDED.content, updated_at=NOW()`,
              [row.asin, JSON.stringify(accordion)],
            )

            // Write normalised EAV rows to catalog.product_attributes (if taxonomy known)
            if (row.taxonomy_path) {
              await this.writeAttributeEAV(
                row.asin,
                row.taxonomy_path,
                row.taxonomy_depth ?? 1,
                accordion,
              )
            }

            processed++
            lastAsin = row.asin
          } catch (err) {
            failed++
            this.logger.warn(
              `Accordion failed ASIN=${row.asin}: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }

        // Checkpoint after every page — restartable at any ASIN
        await this.neon.query(
          `UPDATE cil.enrichment_jobs
           SET processed_items=$2, failed_items=$3, last_processed_asin=$4
           WHERE id=$1`,
          [jobId, processed, failed, lastAsin],
        )

        if (rows.length < safeBatch) break   // last page
      }

      await this.markCompleted(jobId, processed, failed)
    } catch (err) {
      await this.markFailed(jobId, err instanceof Error ? err.message : String(err))
      throw err
    }

    return this.buildResult(jobId, 'accordion_generation', processed, failed, lastAsin)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // QUALITY SCORING — delegates to DataQualityService
  // ════════════════════════════════════════════════════════════════════════════

  async runQualityScoring(
    batchSize:      number = 200,
    resumeFromAsin: string | null = null,
  ): Promise<EnrichmentJobResult> {
    const safeBatch = clampBatch(batchSize)
    const jobId     = uuidv4()

    await this.neon.query(
      `INSERT INTO cil.enrichment_jobs
         (id, job_type, status, config, last_processed_asin, started_at)
       VALUES ($1,'quality_scoring','pending',$2,$3,NOW())`,
      [jobId, JSON.stringify({ batchSize: safeBatch }), resumeFromAsin],
    )

    return this.quality.runBatchScoring({ lastAsin: resumeFromAsin, batchSize: safeBatch, jobId })
  }

  // ════════════════════════════════════════════════════════════════════════════
  // JOB STATUS
  // ════════════════════════════════════════════════════════════════════════════

  async getJobStatus(jobId: string): Promise<EnrichmentJobResult | null> {
    if (!jobId?.trim()) return null
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT id, job_type, status, processed_items, failed_items,
              skipped_items, total_items, last_processed_asin,
              results, started_at, completed_at
       FROM cil.enrichment_jobs WHERE id=$1::uuid`,
      [jobId],
    )
    return rows[0] ? rowToJobResult(rows[0]) : null
  }

  async listRecentJobs(limit = 20): Promise<EnrichmentJobResult[]> {
    const safeLimit = Math.max(1, Math.min(limit, 100))
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT id, job_type, status, processed_items, failed_items,
              skipped_items, total_items, last_processed_asin,
              results, started_at, completed_at
       FROM cil.enrichment_jobs ORDER BY created_at DESC LIMIT $1`,
      [safeLimit],
    )
    return rows.map(rowToJobResult)
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PRIVATE — write EAV rows to catalog.product_attributes
  // ════════════════════════════════════════════════════════════════════════════

  private async writeAttributeEAV(
    asin:          string,
    taxonomyPath:  string,
    taxDepth:      number,
    accordion:     readonly AccordionGroup[],
  ): Promise<void> {
    // Delete existing EAV rows for this product before re-inserting
    await this.neon.query(
      `DELETE FROM catalog.product_attributes WHERE asin = $1 AND taxonomy_depth = $2`,
      [asin, taxDepth],
    ).catch(() => void 0)  // non-fatal

    const rows: any[][] = []
    let sortOrder = 0

    for (const group of accordion) {
      for (const attr of group.attributes) {
        sortOrder++
        const numVal = this.tryParseNumeric(attr.value)
        rows.push([
          asin, taxonomyPath, taxDepth,
          group.group, group.icon ?? null,
          attr.key, attr.label, attr.value,
          numVal, attr.unit ?? null, sortOrder,
        ])
      }
    }

    if (rows.length === 0) return

    // Batch insert
    const placeholders = rows.map((_, i) => {
      const base = i * 11
      return `($${base+1},$${base+2}::ltree,$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11})`
    }).join(',')

    await this.neon.query(
      `INSERT INTO catalog.product_attributes
         (asin,taxonomy_path,taxonomy_depth,attr_group,attr_group_icon,
          attr_key,attr_label,attr_value,attr_value_num,attr_unit,sort_order)
       VALUES ${placeholders}
       ON CONFLICT DO NOTHING`,
      rows.flat(),
    ).catch((err: Error) =>
      this.logger.warn(`EAV write failed for ${asin}: ${err.message.slice(0, 120)}`),
    )
  }

  private tryParseNumeric(value: string): number | null {
    const m = value.match(/^[\s]*(-?[\d,]+\.?\d*)/)
    if (!m) return null
    const n = parseFloat(m[1].replace(/,/g, ''))
    return isNaN(n) ? null : n
  }

  private parseProductDetails(raw: string | null): ParsedProductDetails {
    if (!raw || raw === 'null') return {}
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const result: ParsedProductDetails = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === null || v === undefined) result[k] = null
        else if (typeof v === 'object')    result[k] = JSON.stringify(v)
        else result[k] = v as string | number | boolean
      }
      return result
    } catch { return {} }
  }

  private async markCompleted(jobId: string, processed: number, failed: number): Promise<void> {
    await this.neon.query(
      `UPDATE cil.enrichment_jobs SET status='completed', completed_at=NOW(),
       processed_items=$2, failed_items=$3, total_items=($2+$3) WHERE id=$1`,
      [jobId, processed, failed],
    ).catch((err: Error) => this.logger.warn(`markCompleted failed: ${err.message}`))
  }

  private async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.neon.query(
      `UPDATE cil.enrichment_jobs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
      [jobId, errorMessage.slice(0, 1000)],
    ).catch(() => void 0)
  }

  private buildResult(
    jobId: string, jobType: EnrichmentJobType,
    processed: number, failed: number, lastAsin: string | null,
  ): EnrichmentJobResult {
    return {
      jobId, jobType, status: 'completed',
      processedItems: processed, failedItems: failed,
      skippedItems: 0, totalItems: processed + failed,
      lastProcessedAsin: lastAsin,
      results: { processed, failed },
      startedAt: null, completedAt: new Date(),
    }
  }
}
