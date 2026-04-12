// src/catalog-intelligence/services/attribute-intelligence.service.ts
// =============================================================================
// Attribute Intelligence Service
// The "brain" of the CIL — uses Gemini 1.5 Flash to:
//   1. Group raw product_details into accordion sections
//   2. Generate facet configs per taxonomy family
//   3. Infer attribute data types and units
//   4. Normalize attribute keys (dedup "item_weight" vs "Item Weight" vs "weight")
//
// Design principles:
//   • Rule-based grouping first (fast, free, ~70% coverage)
//   • Gemini only for the remaining ~30% (saves quota)
//   • All Gemini calls cached by content hash (30-day TTL)
//   • Prompt version-pinned — bump AI_PROMPT_VERSION to invalidate cache
//   • Every DB result defensively typed and null-checked
//   • Gemini response validated with Zod before use
// =============================================================================

import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as crypto from 'node:crypto'
import { z } from 'zod'
import type { Pool } from 'pg'
import type {
  AccordionContent,
  AccordionGroup,
  AiCacheEntry,
  ParsedProductDetails,
} from '../types/cil.types'
import { AI_PROMPT_VERSION } from '../types/cil.types'
import { NeonService } from './neon.service'

// ── Accordion group Zod schema — validates Gemini output before use ────────────
const AccordionGroupSchema = z.object({
  group:  z.string().min(1).max(60),
  icon:   z.string().emoji().or(z.string().max(4)),   // allow multi-char emoji
  attributes: z.array(z.object({
    key:   z.string().min(1).max(120),
    label: z.string().min(1).max(120),
    value: z.string().min(1).max(600),
    unit:  z.string().max(20).optional().nullable(),
  })).min(1),
})

const AccordionResponseSchema = z.array(AccordionGroupSchema).min(1).max(16)

// ── Facet config Zod schema ────────────────────────────────────────────────────
const FacetConfigSchema = z.array(z.object({
  key:         z.string().min(1).max(60),
  label:       z.string().min(1).max(80),
  algoliaAttr: z.string().min(1).max(120),
  type:        z.enum(['checkbox','range','rating','boolean','hierarchical']),
  disjunctive: z.boolean(),
  maxValues:   z.number().int().min(1).max(500),
  sortBy:      z.enum(['count','alpha']),
  searchable:  z.boolean(),
})).min(0).max(20)

// ── Rule-based grouping config ─────────────────────────────────────────────────
// Tuned for Amazon product_details keys
// Order matters: first match wins

type GroupRule = {
  readonly keywords: readonly string[]
  readonly group:    string
  readonly icon:     string
}

const GROUPING_RULES: readonly GroupRule[] = Object.freeze([
  {
    keywords: ['bluetooth','wifi','wi_fi','wireless_tech','connectivity','network',
               'nfc','usb','hdmi','port','interface','compatible_devices',
               'compatible_with','compatible_phone','connector_type','total_usb',
               'charging_standard','connection_type'],
    group: 'Connectivity & Compatibility',
    icon:  '📡',
  },
  {
    keywords: ['battery','charge_time','battery_life','battery_average',
               'watt','voltage','power_supply','power_source','output_current',
               'output_voltage','input_voltage','amperage','current_rating'],
    group: 'Power & Battery',
    icon:  '🔋',
  },
  {
    keywords: ['ram','memory','storage','ssd','hdd','hard_drive','processor',
               'cpu','gpu','graphics','chip','cores','operating_system','os',
               'clock_speed','processing_speed'],
    group: 'Performance',
    icon:  '⚡',
  },
  {
    keywords: ['display','screen','resolution','refresh_rate','brightness',
               'panel','aspect_ratio','monitor_size','screen_size','display_type',
               'television_type','viewing_angle'],
    group: 'Display',
    icon:  '🖥️',
  },
  {
    keywords: ['dimension','item_dimension','product_dimension','item_weight',
               'size','height','width','depth','weight','length','diameter',
               'thickness','capacity','volume','item_form','unit_count'],
    group: 'Dimensions & Weight',
    icon:  '📐',
  },
  {
    keywords: ['color','material','finish','texture','fabric','style','design',
               'pattern','shape','enclosure_material','outer_material','inner_material'],
    group: 'Color & Material',
    icon:  '🎨',
  },
  {
    keywords: ['warranty','certification','specification_met','water_resist',
               'ip_rating','compliance','ul_listed','fcc','rohs','legal_disclaimer',
               'safety_information','certification_number'],
    group: 'Warranty & Certifications',
    icon:  '🛡️',
  },
  {
    keywords: ['ingredient','active_ingredient','inactive_ingredient',
               'formulation','scent','fragrance','flavor','directions'],
    group: 'Ingredients & Directions',
    icon:  '🧪',
  },
  {
    keywords: ['skin_type','hair_type','concern','benefit','spf','coverage',
               'finish_type','skin_tone','hair_texture'],
    group: 'Skin & Hair Care',
    icon:  '✨',
  },
  {
    keywords: ['age_range','grade_level','educational','skill_level',
               'number_of_players','minimum_age','recommended_age'],
    group: 'Age & Audience',
    icon:  '👥',
  },
  {
    keywords: ['calorie','protein','carbohydrate','fat','sodium','sugar',
               'fiber','vitamin','mineral','serving_size','nutrition'],
    group: 'Nutrition',
    icon:  '🥗',
  },
  {
    keywords: ['flow_rate','pressure','temperature','humidity','frequency',
               'noise_level','decibel','merv','efficiency','mounting_type',
               'max_velocity','wattage','current_type'],
    group: 'Technical Specifications',
    icon:  '🔧',
  },
  {
    keywords: ['number_of_items','included_components','built_in_media',
               'package_content','set_includes','accessories_included',
               'whats_in_the_box','kit_contents'],
    group: "What's in the Box",
    icon:  '📦',
  },
  {
    keywords: ['model_number','item_model_number','model_name','part_number',
               'upc','manufacturer','brand_name','item_type_name',
               'customer_package_type','additional_features','portable',
               'date_first_available','country_of_origin'],
    group: 'Product Info',
    icon:  'ℹ️',
  },
])

const SKIP_KEYS = new Set<string>([
  'asin','rating','reviews','customer_reviews',
  'best_sellers_rank','size_and_weight',
])

const GEMINI_MODEL = 'gemini-2.0-flash' as const

// Accordion prompt — version-pinned. Bump AI_PROMPT_VERSION to re-generate all.
function buildAccordionPrompt(title: string, attrs: Record<string, string>): string {
  return `You are a product data engineer at Amazon. Your task is to group product specification attributes into logical accordion sections for an e-commerce product detail page.

PRODUCT: "${title.slice(0, 120)}"

RAW ATTRIBUTES (JSON object — every key MUST appear in your output exactly once):
${JSON.stringify(attrs, null, 2).slice(0, 3000)}

INSTRUCTIONS:
1. Create 3-12 accordion groups. Do NOT create a group with fewer than 1 attribute.
2. Every attribute key from the input MUST appear in exactly one group.
3. Use semantically meaningful group names (not generic like "Other" or "Misc").
4. Choose the most appropriate emoji icon per group.
5. Write "label" in Title Case, human-readable (e.g. "battery_average_life" → "Battery Average Life").
6. Keep "value" exactly as given in the input — do NOT modify values.
7. If an attribute value looks like a number+unit (e.g. "54 watts"), extract the numeric part.

RESPOND WITH ONLY a valid JSON array — NO markdown, NO explanation, NO code fences:
[
  {
    "group": "Section Name",
    "icon": "emoji",
    "attributes": [
      { "key": "exact_input_key", "label": "Human Label", "value": "exact_input_value" }
    ]
  }
]`
}

// Facet config prompt
function buildFacetPrompt(
  categoryName: string,
  taxonomyPath: string,
  sampleAttributes: string[],
  productCount: number,
): string {
  return `You are an e-commerce search engineer. Generate the optimal facet/filter configuration for a product category listing page.

CATEGORY: "${categoryName}"
TAXONOMY PATH: "${taxonomyPath}"
PRODUCT COUNT: ${productCount}
SAMPLE ATTRIBUTE KEYS: ${JSON.stringify(sampleAttributes.slice(0, 30))}

ALWAYS INCLUDE these standard facets:
- brand (checkbox, disjunctive)
- price (range)
- avgRating (range, labeled "Customer Rating")
- isPrime (boolean)
- inStock (boolean)

THEN ADD category-specific facets based on the attribute keys above.

RULES:
- "disjunctive: true" means OR logic (user can select multiple values)
- "disjunctive: false" means AND logic (refinement)
- For color/size/style → always disjunctive: true
- For boolean flags → disjunctive: false
- maxValues: 100 for brand, 50 for color/size, 20 for others
- Only include attributes that make sense as FILTERS (not identifiers like model#, UPC)

RESPOND WITH ONLY a valid JSON array — NO markdown, NO explanation:
[
  {
    "key": "queryParamName",
    "label": "UI Display Label",
    "algoliaAttr": "algoliaAttributeName",
    "type": "checkbox" | "range" | "rating" | "boolean" | "hierarchical",
    "disjunctive": true | false,
    "maxValues": 50,
    "sortBy": "count" | "alpha",
    "searchable": true | false
  }
]`
}


@Injectable()
export class AttributeIntelligenceService implements OnModuleInit {
  private readonly logger = new Logger(AttributeIntelligenceService.name)
  private geminiClient: {
    generateContent: (prompt: string) => Promise<{ response: { text: () => string } }>
  } | null = null

  constructor(
    private readonly neon: NeonService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY', '')
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not set — AI features disabled, using rule-based only')
      return
    }
    try {
      // Dynamic import — avoids startup crash if package not installed
      const { GoogleGenerativeAI } = await import('@google/generative-ai').catch(() => {
        this.logger.warn('@google/generative-ai not installed — run: npm i @google/generative-ai')
        return { GoogleGenerativeAI: null }
      })
      if (!GoogleGenerativeAI) return
      const genAI = new GoogleGenerativeAI(apiKey)
      this.geminiClient = genAI.getGenerativeModel({ model: GEMINI_MODEL })
      this.logger.log(`Gemini ${GEMINI_MODEL} initialized`)
    } catch (err) {
      this.logger.error('Failed to init Gemini:', err instanceof Error ? err.message : String(err))
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Generate accordion content for one product.
   * Strategy:
   *   1. Check AI cache (by content hash)
   *   2. Run rule-based grouping
   *   3. If coverage < 65% AND Gemini available → call AI and cache result
   *   4. Return validated AccordionContent
   */
  async generateAccordion(
    asin: string,
    title: string,
    productDetails: ParsedProductDetails,
  ): Promise<AccordionContent> {
    if (!productDetails || Object.keys(productDetails).length === 0) {
      return []
    }

    // Strip non-content keys and null values
    const cleanAttrs = this.cleanAttributes(productDetails)
    if (Object.keys(cleanAttrs).length === 0) {
      return []
    }

    // ── 1. Check cache ─────────────────────────────────────────────────────
    const cacheKey = this.hashContent({ type: 'accordion', version: AI_PROMPT_VERSION, attrs: cleanAttrs })
    const cached = await this.getCachedResponse<AccordionContent>(cacheKey)
    if (cached !== null) {
      return cached
    }

    // ── 2. Rule-based grouping ─────────────────────────────────────────────
    const ruleResult = this.applyGroupingRules(cleanAttrs)
    const ruleAttrCount = ruleResult.reduce((sum, g) => sum + g.attributes.length, 0)
    const totalAttrs = Object.keys(cleanAttrs).length
    const ruleCoverage = totalAttrs > 0 ? ruleAttrCount / totalAttrs : 1

    // ── 3. Gemini if coverage < 65% ────────────────────────────────────────
    if (ruleCoverage >= 0.65 || !this.geminiClient) {
      // Rules are good enough — cache and return
      await this.cacheResponse(cacheKey, 'accordion', ruleResult, 0, 0)
      return ruleResult
    }

    try {
      const aiResult = await this.callGeminiWithRetry(
        buildAccordionPrompt(title, cleanAttrs),
        cacheKey,
        'accordion',
      )
      if (aiResult !== null) {
        return aiResult as AccordionContent
      }
    } catch (err) {
      this.logger.warn(
        `Gemini accordion failed for ASIN ${asin} — falling back to rules: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    return ruleResult
  }

  /**
   * Generate facet configuration for a taxonomy category.
   * Called once per category when a new AttributeFamily is created.
   */
  async generateFacetConfig(
    categoryName: string,
    taxonomyPath: string,
    sampleAttributeKeys: readonly string[],
    productCount: number,
  ): Promise<readonly import('../types/cil.types').FacetConfigEntry[]> {
    const cacheKey = this.hashContent({
      type: 'facet_config',
      version: AI_PROMPT_VERSION,
      path: taxonomyPath,
      keys: [...sampleAttributeKeys].sort(),
    })

    const cached = await this.getCachedResponse<import('../types/cil.types').FacetConfigEntry[]>(cacheKey)
    if (cached !== null) return cached

    // Always include standard facets regardless of AI
    const standardFacets: import('../types/cil.types').FacetConfigEntry[] = [
      { key: 'brand',       label: 'Brand',           algoliaAttr: 'brand',       type: 'checkbox', disjunctive: true,  maxValues: 100, sortBy: 'count', searchable: true  },
      { key: 'priceRange',  label: 'Price',           algoliaAttr: 'price',       type: 'range',    disjunctive: false, maxValues: 0,   sortBy: 'count', searchable: false },
      { key: 'minRating',   label: 'Customer Rating', algoliaAttr: 'avgRating',   type: 'rating',   disjunctive: false, maxValues: 0,   sortBy: 'count', searchable: false },
      { key: 'isPrime',     label: 'Prime Eligible',  algoliaAttr: 'isPrime',     type: 'boolean',  disjunctive: false, maxValues: 2,   sortBy: 'count', searchable: false },
      { key: 'inStock',     label: 'In Stock',        algoliaAttr: 'inStock',     type: 'boolean',  disjunctive: false, maxValues: 2,   sortBy: 'count', searchable: false },
      { key: 'isFreeShip',  label: 'Free Shipping',   algoliaAttr: 'isFreeShip',  type: 'boolean',  disjunctive: false, maxValues: 2,   sortBy: 'count', searchable: false },
      { key: 'color',       label: 'Color',           algoliaAttr: 'colors',      type: 'checkbox', disjunctive: true,  maxValues: 50,  sortBy: 'count', searchable: false },
      { key: 'size',        label: 'Size',            algoliaAttr: 'sizes',       type: 'checkbox', disjunctive: true,  maxValues: 50,  sortBy: 'alpha', searchable: false },
      { key: 'attrs',       label: 'Specifications',  algoliaAttr: 'attrValues',  type: 'checkbox', disjunctive: true,  maxValues: 500, sortBy: 'count', searchable: false },
    ]

    if (!this.geminiClient || sampleAttributeKeys.length === 0) {
      await this.cacheResponse(cacheKey, 'facet_config', standardFacets, 0, 0)
      return standardFacets
    }

    try {
      const aiResult = await this.callGeminiWithRetry(
        buildFacetPrompt(categoryName, taxonomyPath, [...sampleAttributeKeys], productCount),
        cacheKey,
        'facet_config',
      )
      if (aiResult !== null) {
        const parsed = FacetConfigSchema.safeParse(aiResult)
        if (parsed.success) {
          // Merge: AI category-specific + our always-present standard facets
          const aiKeys = new Set(parsed.data.map(f => f.key))
          const merged = [
            ...parsed.data,
            ...standardFacets.filter(f => !aiKeys.has(f.key)),
          ] as readonly import('../types/cil.types').FacetConfigEntry[]
          return merged
        }
      }
    } catch (err) {
      this.logger.warn(
        `Gemini facet config failed for ${categoryName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }

    return standardFacets
  }

  // ════════════════════════════════════════════════════════════════════════════
  // RULE-BASED GROUPING
  // ════════════════════════════════════════════════════════════════════════════

  private applyGroupingRules(attrs: Record<string, string>): AccordionGroup[] {
    const grouped = new Map<string, { icon: string; attrs: AccordionGroup['attributes'][number][] }>()
    const placed = new Set<string>()

    for (const [rawKey, value] of Object.entries(attrs)) {
      const keyLower = rawKey.toLowerCase()
      let matched = false

      for (const rule of GROUPING_RULES) {
        if (rule.keywords.some(kw => keyLower.includes(kw))) {
          if (!grouped.has(rule.group)) {
            grouped.set(rule.group, { icon: rule.icon, attrs: [] })
          }
          grouped.get(rule.group)!.attrs.push({
            key:   rawKey,
            label: this.prettifyKey(rawKey),
            value: this.truncateValue(value),
          })
          placed.add(rawKey)
          matched = true
          break
        }
      }

      if (!matched) {
        if (!grouped.has('General')) {
          grouped.set('General', { icon: '📋', attrs: [] })
        }
        grouped.get('General')!.attrs.push({
          key:   rawKey,
          label: this.prettifyKey(rawKey),
          value: this.truncateValue(value),
        })
      }
    }

    // Emit in GROUPING_RULES order, then General
    const orderedGroups: AccordionGroup[] = []
    for (const rule of GROUPING_RULES) {
      const entry = grouped.get(rule.group)
      if (entry && entry.attrs.length > 0) {
        orderedGroups.push({ group: rule.group, icon: entry.icon, attributes: entry.attrs })
      }
    }
    const general = grouped.get('General')
    if (general && general.attrs.length > 0) {
      orderedGroups.push({ group: 'General', icon: '📋', attributes: general.attrs })
    }

    return orderedGroups
  }

  // ════════════════════════════════════════════════════════════════════════════
  // GEMINI CLIENT
  // ════════════════════════════════════════════════════════════════════════════

  private async callGeminiWithRetry(
    prompt: string,
    cacheKey: string,
    jobType: string,
    maxRetries = 2,
  ): Promise<unknown | null> {
    if (!this.geminiClient) return null

    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.geminiClient.generateContent(prompt)
        const text   = result.response.text().trim()

        // Strip markdown code fences if Gemini adds them despite instructions
        const cleaned = text
          .replace(/^```(?:json)?\s*\n?/m, '')
          .replace(/\n?```\s*$/m, '')
          .trim()

        const parsed = JSON.parse(cleaned) as unknown

        // Validate with Zod based on job type
        if (jobType === 'accordion') {
          const validated = AccordionResponseSchema.safeParse(parsed)
          if (!validated.success) {
            throw new Error(`Zod validation failed: ${validated.error.message.slice(0, 200)}`)
          }
          // Count tokens (approximate — Gemini doesn't always return usage)
          const inputTokens  = Math.ceil(prompt.length / 4)
          const outputTokens = Math.ceil(text.length / 4)
          await this.cacheResponse(cacheKey, jobType, validated.data, inputTokens, outputTokens)
          return validated.data
        }

        if (jobType === 'facet_config') {
          const validated = FacetConfigSchema.safeParse(parsed)
          if (!validated.success) {
            throw new Error(`Zod validation failed: ${validated.error.message.slice(0, 200)}`)
          }
          await this.cacheResponse(cacheKey, jobType, validated.data, 0, 0)
          return validated.data
        }

        return parsed
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt < maxRetries) {
          // Exponential backoff for rate limit errors
          const delay = Math.pow(2, attempt) * 1000
          this.logger.debug(`Gemini retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${lastError.message}`)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    this.logger.warn(`Gemini failed after ${maxRetries + 1} attempts: ${lastError?.message ?? 'unknown'}`)
    return null
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CACHE (Neon PostgreSQL cil.ai_cache)
  // ════════════════════════════════════════════════════════════════════════════

  private async getCachedResponse<T>(contentHash: string): Promise<T | null> {
    try {
      const pool = this.neon.getPool()
      const row = await pool.query<{ response: string }>(
        `SELECT response FROM cil.ai_cache
         WHERE content_hash = $1
           AND expires_at > NOW()
           AND prompt_version = $2`,
        [contentHash, AI_PROMPT_VERSION],
      )
      if ((row.rowCount ?? 0) > 0 && row.rows[0]) {
        return row.rows[0].response as T
      }
    } catch (err) {
      // Cache miss is not an error — log only unexpected failures
      this.logger.debug(`Cache lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return null
  }

  private async cacheResponse(
    contentHash: string,
    jobType: string,
    response: unknown,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    try {
      const pool = this.neon.getPool()
      await pool.query(
        `INSERT INTO cil.ai_cache
           (content_hash, job_type, model_used, prompt_version,
            input_tokens, output_tokens, response)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (content_hash) DO UPDATE SET
           response       = EXCLUDED.response,
           model_used     = EXCLUDED.model_used,
           prompt_version = EXCLUDED.prompt_version,
           expires_at     = NOW() + INTERVAL '30 days'`,
        [
          contentHash,
          jobType,
          GEMINI_MODEL,
          AI_PROMPT_VERSION,
          inputTokens,
          outputTokens,
          JSON.stringify(response),
        ],
      )
    } catch (err) {
      // Cache write failure is non-fatal
      this.logger.warn(`Cache write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ════════════════════════════════════════════════════════════════════════════

  cleanAttributes(pd: ParsedProductDetails): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, val] of Object.entries(pd)) {
      if (SKIP_KEYS.has(key)) continue
      if (val === null || val === undefined || val === '') continue
      const strVal = String(val).trim()
      if (strVal === '' || strVal === 'null' || strVal === 'None') continue
      result[key] = strVal
    }
    return result
  }

  private prettifyKey(key: string): string {
    return key
      .replace(/[_\-]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim()
  }

  private truncateValue(value: string, maxLen = 600): string {
    const clean = value.replace(/\s+/g, ' ').trim()
    return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean
  }

  private hashContent(data: unknown): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(data))
      .digest('hex')
      .slice(0, 32)
  }
}