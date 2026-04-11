// src/departments/departments.controller.ts

import { Controller, Get, Param, Query } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger'
import { successResponse } from '../common/api-utils'
import { DepartmentsService } from './departments.service'

@ApiTags('Departments')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  /**
   * GET /api/departments
   * All departments with product counts, top brands, price ranges, and flags.
   * Derived from store.products in-memory cache — zero DB queries.
   */
  @Get()
  @ApiOperation({
    summary: 'List all departments with aggregated catalog stats',
    description:
      'Returns all active departments derived from store.products taxonomy_dept. ' +
      'Each entry includes product count, subcategory breakdown, top brands, ' +
      'price range, average rating, and flag counts (on-sale, prime, etc.).',
  })
  async findAll() {
    const data = await this.departmentsService.findAll()
    return successResponse(data, { total: data.length })
  }

  /**
   * GET /api/departments/:slug
   * Single department detail + top 8 featured products.
   * Accepts dept slug (e.g. "beauty-and-personal-care") or raw dept name.
   */
  @Get(':slug')
  @ApiOperation({
    summary: 'Department detail with top featured products',
    description:
      'Returns full department stats plus the top 8 best-rated products. ' +
      'Accepts the dept slug or raw taxonomy_dept name.',
  })
  @ApiParam({ name: 'slug', description: 'Department slug or raw name' })
  async findOne(@Param('slug') slug: string) {
    const data = await this.departmentsService.findOne(slug)
    return successResponse(data)
  }

  /**
   * GET /api/departments/:slug/subcategories/:subSlug/products
   * Paginated product listing for a specific dept > subcat.
   */
  @Get(':slug/subcategories/:subSlug/products')
  @ApiOperation({
    summary: 'Paginated products within a department subcategory',
    description: 'Returns products scoped to dept > subcat, sorted by rating desc.',
  })
  @ApiParam({ name: 'slug',    description: 'Department slug or name' })
  @ApiParam({ name: 'subSlug', description: 'Subcategory slug or name' })
  @ApiQuery({ name: 'page',    required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit',   required: false, type: Number, example: 20 })
  async findSubcategoryProducts(
    @Param('slug')    slug:    string,
    @Param('subSlug') subSlug: string,
    @Query('page')    page:    number = 1,
    @Query('limit')   limit:   number = 20,
  ) {
    const data = await this.departmentsService.findSubcategory(
      slug, subSlug,
      { page: Number(page), limit: Math.min(Number(limit), 100) },
    )
    return successResponse(data)
  }
}
