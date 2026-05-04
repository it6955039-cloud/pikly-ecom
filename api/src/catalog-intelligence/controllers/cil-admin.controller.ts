// src/catalog-intelligence/controllers/cil-admin.controller.ts
// FIX v5.0.0: health query uses store.products not catalog.products

import {
  Controller, Get, Post, Body, Param, Query,
  UseGuards, HttpCode, HttpStatus,
  BadRequestException, ParseIntPipe, DefaultValuePipe, ParseBoolPipe,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery, ApiParam, ApiBody } from '@nestjs/swagger'
import { RequireRoleGuard }     from '../../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../../identity/jit/jit-provisioning.guard'
import { RequireRole }          from '../../identity/guards/identity.guards'


import { NeonService }              from '../services/neon.service'
import { AttributeIntelligenceService } from '../services/attribute-intelligence.service'
import { AttributeFamilyService }   from '../services/attribute-family.service'
import { DataQualityService }       from '../services/data-quality.service'
import { EnrichmentPipelineService } from '../services/enrichment-pipeline.service'
import type { CilApiResponse, ParsedProductDetails } from '../types/cil.types'

function ok<T>(data: T, meta?: CilApiResponse<T>['meta']): CilApiResponse<T> {
  return { success: true, data, ...(meta !== undefined ? { meta } : {}) }
}

interface StartJobBody { batchSize?: number; resumeFromAsin?: string | null }

@ApiTags('CIL — Catalog Intelligence Layer')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/cil')
export class CilAdminController {
  constructor(
    private readonly neon:         NeonService,
    private readonly intelligence: AttributeIntelligenceService,
    private readonly families:     AttributeFamilyService,
    private readonly quality:      DataQualityService,
    private readonly pipeline:     EnrichmentPipelineService,
  ) {}

  // ── Health ────────────────────────────────────────────────────────────────

  @Get('health')
  @ApiOperation({ summary: 'CIL health — DB connectivity, counts from store.products' })
  async health(): Promise<CilApiResponse<unknown>> {
    // FIXED: reads from store.products (not catalog.products which is empty)
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*)::int FROM store.products WHERE is_active)          AS product_count,
         (SELECT COUNT(*)::int FROM cil.attribute_families WHERE is_active)  AS family_count,
         (SELECT COUNT(*)::int FROM catalog.product_accordion)               AS accordion_count,
         (SELECT COUNT(*)::int FROM cil.product_quality)                     AS scored_count,
         (SELECT ROUND(AVG(quality_score),1) FROM cil.product_quality)       AS avg_quality,
         (SELECT COUNT(*)::int FROM cil.enrichment_jobs WHERE status='running') AS running_jobs`,
    )
    return ok({ neonHealthy: this.neon.isHealthy(), stats: rows[0] ?? {} })
  }

  // ── Attribute Families ────────────────────────────────────────────────────

  @Get('families')
  @ApiOperation({ summary: 'List all attribute families' })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  async listFamilies(
    @Query('activeOnly', new DefaultValuePipe(true), ParseBoolPipe) activeOnly: boolean,
  ): Promise<CilApiResponse<unknown>> {
    const data = await this.families.findAll(activeOnly)
    return ok(data, { total: data.length })
  }

  @Post('families/generate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Auto-generate attribute families from store.products taxonomy',
    description:
      'Creates one AttributeFamily per department (depth=1) and subcategory (depth=2) ' +
      'that has ≥5 products in store.products. Uses Gemini to generate per-category ' +
      'facet configurations. Idempotent — safe to re-run.',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  async generateFamilies(
    @Query('dryRun', new DefaultValuePipe(false), ParseBoolPipe) dryRun: boolean,
  ): Promise<CilApiResponse<unknown>> {
    const result = await this.families.generateFromTaxonomy(dryRun)
    return ok(result)
  }

  @Post('families/refresh-schema')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh attribute schema for a family',
    description:
      'Analyses store.products.attr_values for all products in this taxonomy ' +
      'and updates the schema with real fill rates. Attributes present in ≥80% ' +
      'of products are marked required.',
  })
  @ApiBody({ schema: { properties: { taxonomyPath: { type: 'string', example: 'Electronics > Headphones' } } } })
  async refreshFamilySchema(
    @Body('taxonomyPath') taxonomyPath: string,
  ): Promise<CilApiResponse<unknown>> {
    if (!taxonomyPath?.trim()) throw new BadRequestException('taxonomyPath is required')
    const family = await this.families.refreshSchema(taxonomyPath.trim())
    return ok(family)
  }

  // ── Accordion ─────────────────────────────────────────────────────────────

  @Post('accordion/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview accordion for a product ASIN (not persisted)',
    description: 'Reads product_details JSONB from store.products and runs AI/rule grouping.',
  })
  @ApiBody({ schema: { properties: { asin: { type: 'string' } } } })
  async previewAccordion(@Body() body: { asin: string }): Promise<CilApiResponse<unknown>> {
    if (!body.asin?.trim()) throw new BadRequestException('asin is required')

    // FIXED: reads from store.products not catalog.products
    const rows = await this.neon.query<{ title: string; product_details: string | null }>(
      `SELECT title, product_details::text AS product_details
       FROM store.products WHERE asin = $1 LIMIT 1`,
      [body.asin.trim()],
    )

    const row = rows[0] ?? null
    if (!row) return ok(null)

    const pd: ParsedProductDetails = {}
    if (row.product_details && row.product_details !== 'null') {
      try {
        const parsed = JSON.parse(row.product_details) as Record<string, unknown>
        for (const [k, v] of Object.entries(parsed)) {
          if (v !== null && v !== undefined) {
            pd[k] = typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)
          }
        }
      } catch { /* empty product_details is fine */ }
    }

    const accordion = await this.intelligence.generateAccordion(body.asin.trim(), row.title ?? '', pd)
    return ok(accordion)
  }

  // ── Enrichment Jobs ───────────────────────────────────────────────────────

  @Post('jobs/accordion')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start (or resume) accordion generation job',
    description: 'Processes all store.products missing catalog.product_accordion entries.',
  })
  async startAccordionJob(@Body() body: StartJobBody): Promise<CilApiResponse<unknown>> {
    const result = await this.pipeline.runAccordionGeneration(body.batchSize ?? 100, body.resumeFromAsin ?? null)
    return ok(result)
  }

  @Post('jobs/quality-scoring')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Start (or resume) quality scoring job',
    description: 'Scores all active store.products across 7 dimensions. Cursor-based — restartable.',
  })
  async startQualityJob(@Body() body: StartJobBody): Promise<CilApiResponse<unknown>> {
    const result = await this.pipeline.runQualityScoring(body.batchSize ?? 200, body.resumeFromAsin ?? null)
    return ok(result)
  }

  @Get('jobs')
  @ApiOperation({ summary: 'List recent enrichment jobs (newest first)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async listJobs(
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<CilApiResponse<unknown>> {
    const jobs = await this.pipeline.listRecentJobs(Math.min(limit, 100))
    return ok(jobs, { total: jobs.length })
  }

  @Get('jobs/:jobId')
  @ApiOperation({ summary: 'Get enrichment job status by ID' })
  @ApiParam({ name: 'jobId', description: 'UUID of the enrichment job' })
  async getJobStatus(@Param('jobId') jobId: string): Promise<CilApiResponse<unknown>> {
    if (!jobId?.trim()) throw new BadRequestException('jobId is required')
    const job = await this.pipeline.getJobStatus(jobId.trim())
    return ok(job)
  }

  // ── Quality Scores ────────────────────────────────────────────────────────

  @Get('quality/summary')
  @ApiOperation({ summary: 'Quality score distribution summary' })
  async getQualitySummary(): Promise<CilApiResponse<unknown>> {
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT
         COUNT(*)::int                                                 AS total_scored,
         ROUND(AVG(quality_score), 1)                                  AS avg_score,
         COUNT(*) FILTER (WHERE quality_score >= 80)::int             AS high_quality,
         COUNT(*) FILTER (WHERE quality_score BETWEEN 50 AND 79)::int AS medium_quality,
         COUNT(*) FILTER (WHERE quality_score < 50)::int              AS low_quality,
         COUNT(*) FILTER (WHERE needs_rescore = true)::int            AS pending_rescore
       FROM cil.product_quality`,
    )
    return ok(rows[0] ?? {})
  }

  @Get('quality')
  @ApiOperation({ summary: 'List products by quality score (worst first, cursor-paginated)' })
  @ApiQuery({ name: 'maxScore', required: false, type: Number })
  @ApiQuery({ name: 'limit',    required: false, type: Number })
  @ApiQuery({ name: 'cursor',   required: false, type: String })
  async getQualityScores(
    @Query('maxScore', new DefaultValuePipe(100), ParseIntPipe) maxScore: number,
    @Query('limit',    new DefaultValuePipe(50),  ParseIntPipe) limit: number,
    @Query('cursor')   cursor?: string,
  ): Promise<CilApiResponse<unknown>> {
    const safeLimit = Math.max(1, Math.min(limit, 200))
    // FIXED: JOINs store.products not catalog.products
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT q.asin, p.title, p.taxonomy_dept, p.cat_lvl0,
              q.quality_score, q.score_title, q.score_images,
              q.score_description, q.score_attributes, q.score_variants,
              q.score_reviews, q.score_taxonomy,
              q.issues, q.missing_attrs, q.attribute_coverage, q.scored_at
       FROM cil.product_quality q
       JOIN store.products p ON p.asin = q.asin
       WHERE q.quality_score <= $1
         AND ($2::text IS NULL OR q.asin > $2)
       ORDER BY q.quality_score ASC, q.asin ASC
       LIMIT $3`,
      [maxScore, cursor ?? null, safeLimit],
    )
    const nextCursor = rows.length === safeLimit
      ? String(rows[rows.length - 1]?.['asin'] ?? '') : null
    return ok(rows, { total: rows.length, cursor: nextCursor })
  }

  // ── Facet Configs ─────────────────────────────────────────────────────────

  @Get('facets')
  @ApiOperation({ summary: 'List all facet configurations' })
  async listFacetConfigs(): Promise<CilApiResponse<unknown>> {
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT taxonomy_path, facets, sort_options, ai_generated, generated_at
       FROM cil.facet_configs WHERE is_active = true ORDER BY taxonomy_path`,
    )
    return ok(rows, { total: rows.length })
  }

  @Get('facets/:path')
  @ApiOperation({ summary: 'Get facet config for a taxonomy path (URL-encoded)' })
  @ApiParam({ name: 'path', description: 'URL-encoded taxonomy path e.g. "Electronics > Headphones"' })
  async getFacetConfig(@Param('path') encodedPath: string): Promise<CilApiResponse<unknown>> {
    const path = decodeURIComponent(encodedPath ?? '')
    if (!path) throw new BadRequestException('path is required')
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT facets, sort_options, ai_generated, generated_at
       FROM cil.facet_configs WHERE taxonomy_path = $1 AND is_active = true`,
      [path],
    )
    return ok(rows[0] ?? null)
  }

  // ── AI Cache ──────────────────────────────────────────────────────────────

  @Get('cache/stats')
  @ApiOperation({ summary: 'AI cache statistics — hit rate, entry count, token usage' })
  async getCacheStats(): Promise<CilApiResponse<unknown>> {
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT job_type, COUNT(*)::int AS entries,
              SUM(input_tokens)::int AS total_input_tokens,
              SUM(output_tokens)::int AS total_output_tokens,
              MIN(created_at) AS oldest_entry, MAX(created_at) AS newest_entry
       FROM cil.ai_cache WHERE expires_at > NOW()
       GROUP BY job_type ORDER BY entries DESC`,
    )
    return ok(rows)
  }
}
