// src/catalog-intelligence/services/attribute-family.service.ts  v5.0.0
//
// generateFromTaxonomy() reads store.products taxonomy columns, derives LTREE
// paths, and populates cil.attribute_families + cil.facet_configs.
//
// LTREE path format: dept_slug.subcat_slug
//   "Beauty and Personal Care" + "Toners" → beauty_and_personal_care.toners
// This matches exactly what the store.products trigger computes.

import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { NeonService }                from './neon.service'
import { AttributeIntelligenceService } from './attribute-intelligence.service'
import type { AttributeFamily, AttributeSchemaEntry, FacetConfigEntry } from '../types/cil.types'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert a human-readable dept/subcat string to an LTREE-safe label */
function toLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/** Build LTREE path from dept + optional subcat */
function ltreePath(dept: string, subcat?: string): string {
  const d = toLabel(dept)
  if (!d) return ''
  if (!subcat) return d
  const s = toLabel(subcat)
  return s ? `${d}.${s}` : d
}

/** Human-readable slug for URL use */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120)
}

function parseJsonField<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback
  if (typeof raw === 'object') return raw as T
  if (typeof raw === 'string' && raw !== '') {
    try { return JSON.parse(raw) as T } catch { return fallback }
  }
  return fallback
}

function rowToFamily(row: Record<string, unknown>): AttributeFamily {
  return {
    id:              String(row['id'] ?? ''),
    taxonomyPath:    String(row['taxonomy_path'] ?? ''),
    taxonomyDepth:   Number(row['taxonomy_depth'] ?? 1),
    name:            String(row['name'] ?? ''),
    slug:            String(row['slug'] ?? ''),
    description:     typeof row['description'] === 'string' ? row['description'] : null,
    attributeSchema: parseJsonField<AttributeSchemaEntry[]>(row['attribute_schema'], []),
    facetConfig:     parseJsonField<FacetConfigEntry[]>(row['facet_config'], []),
    schemaCoverage:  Number(row['schema_coverage'] ?? 0),
    lastAiReview:    row['last_ai_review'] instanceof Date ? row['last_ai_review'] : null,
    aiModelUsed:     typeof row['ai_model_used'] === 'string' ? row['ai_model_used'] : null,
    isActive:        Boolean(row['is_active'] ?? true),
  }
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class AttributeFamilyService {
  private readonly logger = new Logger(AttributeFamilyService.name)

  constructor(
    private readonly neon:         NeonService,
    private readonly intelligence: AttributeIntelligenceService,
  ) {}

  async findAll(activeOnly = true): Promise<AttributeFamily[]> {
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT id, taxonomy_path::text, taxonomy_depth, name, slug, description,
              attribute_schema, facet_config, schema_coverage,
              last_ai_review, ai_model_used, is_active
       FROM cil.attribute_families
       WHERE ($1 = false OR is_active = true)
       ORDER BY taxonomy_depth ASC, name ASC`,
      [activeOnly],
    )
    return rows.map(rowToFamily)
  }

  async findByPath(ltreePathStr: string): Promise<AttributeFamily | null> {
    const rows = await this.neon.query<Record<string, unknown>>(
      `SELECT id, taxonomy_path::text, taxonomy_depth, name, slug, description,
              attribute_schema, facet_config, schema_coverage,
              last_ai_review, ai_model_used, is_active
       FROM cil.attribute_families WHERE taxonomy_path = $1::ltree`,
      [ltreePathStr],
    )
    return rows[0] ? rowToFamily(rows[0]) : null
  }

  // ════════════════════════════════════════════════════════════════════════════
  // generateFromTaxonomy
  //
  // Reads store.products taxonomy columns → derives LTREE paths →
  // upserts cil.attribute_families (with LTREE taxonomy_path) +
  // cil.facet_configs (with LTREE taxonomy_path).
  //
  // catalog.products is already synced via the DB trigger — we don't
  // touch it here. We do use catalog.product_attributes to gather attr keys
  // if available (falls back to store.products.attr_values TEXT[] if not).
  // ════════════════════════════════════════════════════════════════════════════

  async generateFromTaxonomy(dryRun = false): Promise<{
    created: number; updated: number; skipped: number; names: string[]
  }> {
    // Derive departments (depth=1 nodes)
    const deptRows = await this.neon.query<{ dept: string; cnt: number }>(
      `SELECT taxonomy_dept AS dept, COUNT(*)::int AS cnt
       FROM store.products
       WHERE is_active = true AND taxonomy_dept <> ''
       GROUP BY taxonomy_dept HAVING COUNT(*) >= 5
       ORDER BY cnt DESC`,
    )

    // Derive subcategories (depth=2 nodes)
    const subcatRows = await this.neon.query<{ dept: string; subcat: string; cnt: number }>(
      `SELECT taxonomy_dept AS dept, taxonomy_subcat AS subcat, COUNT(*)::int AS cnt
       FROM store.products
       WHERE is_active = true AND taxonomy_dept <> '' AND taxonomy_subcat <> ''
       GROUP BY taxonomy_dept, taxonomy_subcat HAVING COUNT(*) >= 5
       ORDER BY cnt DESC`,
    )

    type TaxNode = { lpath: string; name: string; depth: number; cnt: number; dept: string; subcat: string }
    const nodes: TaxNode[] = [
      ...deptRows.map(r => ({
        lpath: ltreePath(r.dept), name: r.dept, depth: 1, cnt: r.cnt, dept: r.dept, subcat: '',
      })),
      ...subcatRows.map(r => ({
        lpath: ltreePath(r.dept, r.subcat), name: r.subcat, depth: 2, cnt: r.cnt, dept: r.dept, subcat: r.subcat,
      })),
    ].filter(n => n.lpath !== '')

    let created = 0, updated = 0, skipped = 0
    const names: string[] = []

    for (const node of nodes) {
      // Gather sample attribute keys from attr_values TEXT[] (e.g. "bluetooth_version:5.3")
      // Falls back to catalog.product_attributes if populated (post-accordion-job)
      const attrKeyRows = await this.neon.query<{ attr_key: string }>(
        node.depth === 2
          ? `SELECT DISTINCT split_part(v, ':', 1) AS attr_key
             FROM store.products p, unnest(p.attr_values) AS v
             WHERE p.is_active = true
               AND p.taxonomy_dept = $1 AND p.taxonomy_subcat = $2
               AND v <> '' AND split_part(v,':',1) <> ''
             LIMIT 60`
          : `SELECT DISTINCT split_part(v, ':', 1) AS attr_key
             FROM store.products p, unnest(p.attr_values) AS v
             WHERE p.is_active = true
               AND p.taxonomy_dept = $1
               AND v <> '' AND split_part(v,':',1) <> ''
             LIMIT 60`,
        node.depth === 2 ? [node.dept, node.subcat] : [node.dept],
      )
      const attrKeys = attrKeyRows.map(r => r.attr_key).filter(k => k.length > 0)

      if (dryRun) {
        this.logger.log(
          `[DRY RUN] Would create family "${node.name}" ` +
          `(ltree=${node.lpath}, depth=${node.depth}, products=${node.cnt}, attrs=${attrKeys.length})`,
        )
        created++; names.push(node.name); continue
      }

      try {
        const facetConfig = await this.intelligence.generateFacetConfig(
          node.name, node.lpath, attrKeys, node.cnt,
        )

        // Slug: human-readable URL segment
        const slug = node.depth === 2
          ? toSlug(`${node.dept}--${node.subcat}`)
          : toSlug(node.dept)

        // Upsert family — taxonomy_path is LTREE column
        const result = await this.neon.query<{ id: string; was_insert: boolean }>(
          `INSERT INTO cil.attribute_families
             (taxonomy_path, taxonomy_depth, name, slug,
              attribute_schema, facet_config, last_ai_review, ai_model_used)
           VALUES ($1::ltree, $2, $3, $4, '[]'::jsonb, $5::jsonb, NOW(), 'gemini-1.5-flash')
           ON CONFLICT (taxonomy_path) DO UPDATE SET
             facet_config   = EXCLUDED.facet_config,
             taxonomy_depth = EXCLUDED.taxonomy_depth,
             last_ai_review = NOW(),
             updated_at     = NOW()
           RETURNING id, (xmax = 0) AS was_insert`,
          [node.lpath, node.depth, node.name, slug, JSON.stringify(facetConfig)],
        )

        // Mirror into cil.facet_configs (also LTREE)
        await this.neon.query(
          `INSERT INTO cil.facet_configs (taxonomy_path, facets, ai_generated, generated_at)
           VALUES ($1::ltree, $2::jsonb, true, NOW())
           ON CONFLICT (taxonomy_path) DO UPDATE SET
             facets = EXCLUDED.facets, generated_at = NOW(), updated_at = NOW()`,
          [node.lpath, JSON.stringify(facetConfig)],
        )

        if (result[0]?.was_insert === true) { created++ } else { updated++ }
        names.push(node.name)
        this.logger.log(`Family upserted: "${node.name}" → ${node.lpath} (depth=${node.depth})`)
      } catch (err) {
        skipped++
        this.logger.warn(
          `Family generation failed for ${node.lpath}: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    return { created, updated, skipped, names }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // refreshSchema — rebuild attribute_schema from real product data
  // Uses store.products.attr_values TEXT[] (attr key extracted via split_part)
  // ════════════════════════════════════════════════════════════════════════════

  async refreshSchema(taxonomyPathStr: string): Promise<AttributeFamily> {
    if (!taxonomyPathStr?.trim()) throw new NotFoundException('taxonomyPath required')

    // Resolve family to get dept + subcat names
    const parts = taxonomyPathStr.split('.')
    const depth = parts.length

    // Convert LTREE labels back to approximate dept/subcat for WHERE clause
    // We use catalog.products.taxonomy_path <@ for the proper LTREE subtree match
    const totalRow = await this.neon.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM catalog.products
       WHERE is_active = true AND taxonomy_path <@ $1::ltree`,
      [taxonomyPathStr],
    )
    const total = totalRow[0]?.cnt ?? 0

    // Get attribute fill rates from store.products.attr_values
    // via the catalog.products join (LTREE subtree)
    const attrRows = await this.neon.query<{ attr_key: string; fill_count: number }>(
      `SELECT split_part(v, ':', 1) AS attr_key, COUNT(*)::int AS fill_count
       FROM store.products sp
       JOIN catalog.products cp ON cp.asin = sp.asin
       , unnest(sp.attr_values) AS v
       WHERE cp.is_active = true
         AND cp.taxonomy_path <@ $1::ltree
         AND v <> ''
         AND split_part(v,':',1) <> ''
       GROUP BY attr_key
       ORDER BY fill_count DESC
       LIMIT 80`,
      [taxonomyPathStr],
    )

    const schema: AttributeSchemaEntry[] = attrRows.map(r => ({
      key:        r.attr_key,
      label:      r.attr_key.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      group:      'General',
      type:       'text' as const,
      required:   total > 0 && r.fill_count / total >= 0.8,
      searchable: true,
    }))

    const coverage = total > 0 && attrRows.length > 0
      ? Math.round((attrRows[0]?.fill_count ?? 0) / total * 100) : 0

    const lastName = parts[parts.length - 1] ?? taxonomyPathStr
    const slug = toSlug(taxonomyPathStr.replace(/\./g, '--'))

    await this.neon.query(
      `INSERT INTO cil.attribute_families
         (taxonomy_path, taxonomy_depth, name, slug, attribute_schema, schema_coverage, updated_at)
       VALUES ($1::ltree, $2, $3, $4, $5::jsonb, $6, NOW())
       ON CONFLICT (taxonomy_path) DO UPDATE SET
         attribute_schema = EXCLUDED.attribute_schema,
         schema_coverage  = EXCLUDED.schema_coverage,
         updated_at       = NOW()`,
      [taxonomyPathStr, depth, lastName.replace(/_/g, ' '), slug, JSON.stringify(schema), coverage],
    )

    const updated = await this.findByPath(taxonomyPathStr)
    if (!updated) throw new NotFoundException(`Family not found after upsert: ${taxonomyPathStr}`)
    return updated
  }
}
