import { Injectable } from '@nestjs/common'
import { CategoryShowcaseDto } from './dto/category-showcase.dto'
import { ProductsService } from '../products/products.service'
import { CategoriesService } from '../categories/categories.service'
import { smartPaginate } from '../common/api-utils'

@Injectable()
export class CategoryShowcaseService {
  constructor(
    private readonly productsService: ProductsService,
    private readonly categoriesService: CategoriesService,
  ) {}

  private capitalize(str: string) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1).replace(/-/g, ' ') : str
  }

  getShowcase(dto: CategoryShowcaseDto) {
    const {
      page = 1,
      limit = 6,
      productsLimit = 4,
      category,
      onlyFeatured = false,
      sort = 'productCount',
      cursor,
    } = dto

    const categoryMap = new Map<
      string,
      { categoryName: string; categorySlug: string; featured: boolean; products: any[] }
    >()

    for (const product of this.productsService.products) {
      if (!product.isActive) continue
      const key = product.category as string
      if (!categoryMap.has(key)) {
        const catMeta = this.categoriesService.categories.find(
          (c: any) => c.slug === key || c.name?.toLowerCase() === key?.toLowerCase(),
        )
        categoryMap.set(key, {
          categoryName: catMeta?.name ?? this.capitalize(key),
          categorySlug: key,
          featured: catMeta?.featured ?? false,
          products: [],
        })
      }
      categoryMap.get(key)!.products.push(product)
    }

    let categories = Array.from(categoryMap.values())
    if (category)
      categories = categories.filter((c) => c.categorySlug.toLowerCase() === category.toLowerCase())
    if (onlyFeatured) categories = categories.filter((c) => c.featured)
    if (sort === 'alphabetical')
      categories.sort((a, b) => a.categoryName.localeCompare(b.categoryName))
    else categories.sort((a, b) => b.products.length - a.products.length)

    const paginated = smartPaginate(categories, {
      page: cursor ? undefined : (page ?? 1),
      limit: limit ?? 6,
      cursor: cursor ?? undefined,
    })

    return {
      categories: paginated.items.map((cat: any) => ({
        categoryName: cat.categoryName,
        categorySlug: cat.categorySlug,
        totalProducts: cat.products.length,
        products: cat.products.slice(0, productsLimit).map((p: any) => ({
          title: p.title,
          slug: p.slug,
          image: p.media?.mainImage ?? p.media?.images?.[0]?.url ?? p.media?.thumb ?? null,
        })),
      })),
      pagination: {
        total: paginated.total,
        limit: paginated.limit,
        hasNextPage: paginated.hasNextPage,
        hasPrevPage: paginated.hasPrevPage,
        mode: paginated.mode,
        ...(paginated.mode === 'offset' && {
          page: (paginated as any).page,
          totalPages: (paginated as any).totalPages,
        }),
        ...(paginated.mode === 'cursor' && {
          nextCursor: (paginated as any).nextCursor,
          prevCursor: (paginated as any).prevCursor,
        }),
      },
    }
  }
}
