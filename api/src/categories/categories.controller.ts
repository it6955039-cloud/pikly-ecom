import { Controller, Get, Param, Query } from '@nestjs/common'
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { paginatedResponse, successResponse } from '../common/api-utils'
import { ProductsService } from '../products/products.service'
import { CategoriesService } from './categories.service'

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly productsService: ProductsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get full category tree (hierarchical)' })
  findAll() {
    const data = this.categoriesService.getTree()
    return successResponse(data)
  }

  @Get('featured')
  @ApiOperation({ summary: 'Get featured categories' })
  findFeatured() {
    return successResponse(this.categoriesService.findAll(true))
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get single category with children' })
  @ApiParam({ name: 'slug' })
  findOne(@Param('slug') slug: string) {
    return successResponse(this.categoriesService.findBySlug(slug))
  }

  @Get(':slug/products')
  @ApiOperation({ summary: 'Get products filtered by category slug' })
  @ApiParam({ name: 'slug' })
  async findProducts(@Param('slug') slug: string, @Query() query: any) {
    const category = await this.categoriesService.findBySlug(slug)
    const products = this.productsService.products.filter(
      (p: any) => p.cat_lvl0 === category.slug || p.taxonomy_dept === category.name,
    )
    const page = Math.max(1, Number(query.page ?? 1))
    const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)))
    const start = (page - 1) * limit
    const items = products.slice(start, start + limit)
    return paginatedResponse(
      items,
      { total: products.length, page, limit, totalPages: Math.ceil(products.length / limit) },
      {},
    )
  }
}
