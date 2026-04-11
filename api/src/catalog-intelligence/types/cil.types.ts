// src/catalog-intelligence/types/cil.types.ts  v5.0.0
// LTREE taxonomy paths are used throughout CIL.
// Format: dept_slug.subcat_slug  (dots as hierarchy separator)
// Example: "beauty_and_personal_care.toners"
// The store.products trigger auto-computes this from taxonomy_dept + taxonomy_subcat.

export interface AccordionAttribute {
  readonly key:   string
  readonly label: string
  readonly value: string
  readonly unit?: string | null
}

export interface AccordionGroup {
  readonly group:      string
  readonly icon:       string
  readonly attributes: readonly AccordionAttribute[]
}

export type AccordionContent = readonly AccordionGroup[]

export type AttributeDataType = 'text' | 'numeric' | 'boolean' | 'url' | 'enum'

export interface AttributeRegistryEntry {
  readonly id:             string
  readonly rawKey:         string
  readonly canonicalKey:   string
  readonly canonicalLabel: string
  readonly groupName:      string
  readonly groupIcon:      string
  readonly dataType:       AttributeDataType
  readonly unit:           string | null
  readonly familyPaths:    readonly string[]   // LTREE[] stored as text[]
  readonly isFacetable:    boolean
  readonly isSearchable:   boolean
  readonly isRequired:     boolean
  readonly productCount:   number
  readonly nullCount:      number
  readonly knownValues:    readonly string[]
}

export interface AttributeSchemaEntry {
  readonly key:        string
  readonly label:      string
  readonly group:      string
  readonly type:       AttributeDataType
  readonly required:   boolean
  readonly searchable: boolean
  readonly unit?:      string
}

export interface FacetConfigEntry {
  readonly key:          string
  readonly label:        string
  readonly algoliaAttr:  string
  readonly type:         'checkbox' | 'range' | 'rating' | 'boolean' | 'hierarchical'
  readonly disjunctive:  boolean
  readonly maxValues:    number
  readonly sortBy:       'count' | 'alpha'
  readonly searchable:   boolean
}

export interface SortOption {
  readonly key:            string
  readonly label:          string
  readonly algoliaReplica: string
}

export interface AttributeFamily {
  readonly id:              string
  readonly taxonomyPath:    string   // LTREE stored as text: e.g. "beauty_and_personal_care.toners"
  readonly taxonomyDepth:   number
  readonly name:            string
  readonly slug:            string
  readonly description:     string | null
  readonly attributeSchema: readonly AttributeSchemaEntry[]
  readonly facetConfig:     readonly FacetConfigEntry[]
  readonly schemaCoverage:  number
  readonly lastAiReview:    Date | null
  readonly aiModelUsed:     string | null
  readonly isActive:        boolean
}

export type IssueSeverity = 'critical' | 'warning' | 'info'

export interface QualityIssue {
  readonly code:     string
  readonly severity: IssueSeverity
  readonly message:  string
  readonly field?:   string
}

export interface ProductQualityScore {
  readonly asin:               string
  readonly productId:          string
  readonly qualityScore:       number
  readonly scoreDimensions: {
    readonly title:       number
    readonly images:      number
    readonly description: number
    readonly attributes:  number
    readonly variants:    number
    readonly reviews:     number
    readonly taxonomy:    number
  }
  readonly issues:             readonly QualityIssue[]
  readonly missingAttrs:       readonly string[]
  readonly presentAttrs:       readonly string[]
  readonly attributeCoverage:  number
  readonly scoredAt:           Date | null
  readonly needsRescore:       boolean
}

export type EnrichmentJobType =
  | 'accordion_generation'
  | 'quality_scoring'
  | 'attribute_normalization'
  | 'facet_config_generation'
  | 'family_assignment'
  | 'variant_image_fill'
  | 'cross_sell_enrichment'

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface EnrichmentJobResult {
  readonly jobId:             string
  readonly jobType:           EnrichmentJobType
  readonly status:            JobStatus
  readonly processedItems:    number
  readonly failedItems:       number
  readonly skippedItems:      number
  readonly totalItems:        number
  readonly lastProcessedAsin: string | null
  readonly results:           Record<string, unknown>
  readonly startedAt:         Date | null
  readonly completedAt:       Date | null
}

export interface BatchCursor {
  readonly lastAsin:  string | null
  readonly batchSize: number
  readonly jobId:     string
}

export const AI_PROMPT_VERSION = 'v3' as const

export interface AiCacheEntry {
  readonly contentHash:   string
  readonly jobType:       string
  readonly modelUsed:     string
  readonly promptVersion: string
  readonly inputTokens:   number
  readonly outputTokens:  number
  readonly response:      unknown
  readonly createdAt:     Date
  readonly expiresAt:     Date
}

export interface RawProductRow {
  readonly asin:          string
  readonly taxonomy_path: string   // LTREE column returned as text by pg driver
  readonly taxonomy_dept: string
  readonly taxonomy_sub:  string
  readonly pr_json:       Record<string, unknown>
  readonly pd_json:       Record<string, unknown>
}

export interface ParsedProductDetails {
  [key: string]: string | number | boolean | null | undefined
}

export interface CilApiResponse<T> {
  readonly success: boolean
  readonly data:    T
  readonly meta?: {
    readonly total?:    number
    readonly page?:     number
    readonly pageSize?: number
    readonly cursor?:   string | null
  }
}

export interface CilErrorResponse {
  readonly success: false
  readonly error:   string
  readonly code:    string
  readonly details?: unknown
}
