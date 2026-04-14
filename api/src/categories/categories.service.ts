import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common'
import { CacheService } from '../common/cache.service'
import { DatabaseService } from '../database/database.service'

@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly logger = new Logger(CategoriesService.name)
  categories: any[] = []
  private loadingPromise: Promise<void> | null = null

  constructor(
    private readonly db: DatabaseService,
    private readonly cache: CacheService,
  ) {}

  async onModuleInit() {
    // Start loading in background — don't block startup
    this.loadingPromise = this.initializeAsync()
  }

  private async initializeAsync(): Promise<void> {
    try {
      await this.db.waitUntilReady()
      await this.loadCategories()
      this.logger.log('Categories initialized successfully')
    } catch (error) {
      this.logger.error(`Failed to initialize categories: ${error}`)
      // Continue with empty categories array — app can still start
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.loadingPromise) {
      await this.loadingPromise
    }
  }

  async loadCategories() {
    const rows = await this.db.query<any>(
      'SELECT * FROM store.categories WHERE is_active=true ORDER BY level ASC, sort_order ASC',
    )
    this.categories = rows
    this.logger.log(`Categories loaded: ${rows.length}`)
    return rows
  }

  findAll(featuredOnly = false) {
    return featuredOnly ? this.categories.filter((c) => c.is_featured) : this.categories
  }

  async findBySlug(slug: string) {
    await this.ensureLoaded()
    const cat = this.categories.find((c) => c.slug === slug)
    if (!cat) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND' })
    const children = this.categories.filter((c) => c.parent_id === cat.id)
    return { ...cat, children }
  }

  async getTree() {
    await this.ensureLoaded()
    const roots = this.categories.filter((c) => !c.parent_id)
    const build = (parent: any): any => ({
      ...parent,
      children: this.categories.filter((c) => c.parent_id === parent.id).map(build),
    })
    return roots.map(build)
  }

  async adminCreate(dto: any) {
    // Auto-generate a URL-safe slug from the name if the caller omits it
    const slug =
      dto.slug ??
      dto.name
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
    const row = await this.db.queryOne<any>(
      `INSERT INTO store.categories (id,name,slug,parent_id,level,description,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        dto.id ?? `cat_${slug}`,
        dto.name,
        slug,
        dto.parentId ?? null,
        dto.level ?? 0,
        dto.description ?? '',
        dto.sortOrder ?? 0,
      ],
    )
    await this.loadCategories()
    return row
  }

  async adminUpdate(id: string, dto: any) {
    const sets = ['updated_at=NOW()']
    const vals: any[] = []
    let i = 1
    for (const k of [
      'name',
      'description',
      'is_featured',
      'is_active',
      'sort_order',
      'image',
      'facets',
    ]) {
      if (k in dto) {
        sets.push(`${k}=$${i++}`)
        vals.push(dto[k])
      }
    }
    vals.push(id)
    const row = await this.db.queryOne<any>(
      `UPDATE store.categories SET ${sets.join(',')} WHERE id=$${i} RETURNING *`,
      vals,
    )
    if (!row) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND' })
    await this.loadCategories()
    return row
  }

  async refreshProductCounts() {
    await this.db.execute(`
      UPDATE store.categories c
      SET product_count = (
        SELECT COUNT(*)::int FROM store.products p
        WHERE (p.taxonomy_dept = c.name OR p.cat_lvl0 = c.name OR p.cat_lvl1 ILIKE '%' || c.name || '%')
          AND p.is_active = true
      )
    `)
    await this.loadCategories()
    return { updated: true }
  }

  async adminDelete(id: string) {
    const n = await this.db.execute('DELETE FROM store.categories WHERE id = $1', [id])
    if (n === 0) throw new Error('Category not found')
    await this.loadCategories()
    return { deleted: true }
  }
}
