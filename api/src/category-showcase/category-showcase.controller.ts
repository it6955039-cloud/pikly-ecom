import { Controller, Get, Query } from '@nestjs/common'
import { ApiTags, ApiOperation } from '@nestjs/swagger'
import { CategoryShowcaseService } from './category-showcase.service'
import { CategoryShowcaseDto } from './dto/category-showcase.dto'

@ApiTags('Category Showcase')
@Controller('category-showcase')
export class CategoryShowcaseController {
  constructor(private readonly service: CategoryShowcaseService) {}

  @Get()
  @ApiOperation({
    summary: 'Get categories with product grid for showcase UI',
    description: `
Returns paginated category boxes, each with N products (image + name).
Perfect for a 2x2 product grid UI per category.

Query params:
- page           → which page of categories (default: 1)
- limit          → how many category boxes per page (default: 6)
- productsLimit  → products per category box (default: 4)
- category       → filter by category slug e.g. electronics
- onlyFeatured   → only featured categories (true/false)
- sort           → alphabetical | productCount
    `,
  })
  getShowcase(@Query() dto: CategoryShowcaseDto) {
    const result = this.service.getShowcase(dto)
    return {
      success: true,
      data: {
        categories: result.categories,
      },
      meta: {
        pagination: result.pagination,
        productsPerBox: dto.productsLimit ?? 4,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    }
  }
}
