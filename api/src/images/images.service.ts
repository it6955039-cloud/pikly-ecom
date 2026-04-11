import { Injectable } from '@nestjs/common'
import { ProductsService } from '../products/products.service'
import { smartPaginate } from '../common/api-utils'

@Injectable()
export class ImagesService {
  constructor(private readonly productsService: ProductsService) {}

  getImages(query: { page?: number; limit?: number; cursor?: string }) {
    const { page, limit = 10, cursor } = query

    const allProducts = this.productsService.products
      .filter((p) => p.isActive)
      .map((p) => ({
        title: p.title,
        slug: p.slug,
        categoryName: p.subSubcategory ?? p.subcategory ?? p.category,
        media: p.media,
      }))

    const paginated = smartPaginate(allProducts, { page, limit, cursor })

    const grouped: Record<string, any[]> = {}
    for (const p of paginated.items) {
      if (!grouped[p.categoryName]) grouped[p.categoryName] = []
      grouped[p.categoryName].push({ title: p.title, slug: p.slug, media: p.media })
    }

    return {
      imagesData: Object.entries(grouped).map(([categoryName, products]) => ({
        categoryName,
        products,
      })),
      totalProducts: paginated.total,
      limit: paginated.limit,
      hasNextPage: paginated.hasNextPage,
      hasPrevPage: paginated.hasPrevPage,
      mode: paginated.mode,
      ...(paginated.mode === 'offset' && {
        currentPage: (paginated as any).page,
        totalPages: (paginated as any).totalPages,
        nextPage: paginated.hasNextPage ? (paginated as any).page + 1 : null,
        prevPage: paginated.hasPrevPage ? (paginated as any).page - 1 : null,
      }),
      ...(paginated.mode === 'cursor' && {
        nextCursor: (paginated as any).nextCursor,
        prevCursor: (paginated as any).prevCursor,
      }),
    }
  }
}
