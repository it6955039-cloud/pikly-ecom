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
   */
  @Get(':slug')
  @ApiOperation({
    summary: 'Department detail with top 8 featured products',
    description:
      'Returns full department stats plus the top 8 best-rated products. ' +
      'Accepts the dept slug or raw taxonomy_dept name.',
  })
  @ApiParam({ name: 'slug', description: 'Department slug or raw name', example: 'baby-products' })
  async findOne(@Param('slug') slug: string) {
    const data = await this.departmentsService.findOne(slug)
    return successResponse(data)
  }

  /**
   * GET /api/departments/:slug/search
   * Global search within a department across ALL subcategories with facets.
   */
  @Get(':slug/search')
  @ApiOperation({
    summary: 'Search products within a department (all subcategories) with facets',
    description:
      'Full-text search across title, brand, ASIN, and slug within the given department. ' +
      'Supports filtering by brand, subcategory, price range, rating, stock status, sale status, and Prime. ' +
      'Returns paginated products + facets for building filter UI. ' +
      'Facets are computed from the query-matched set BEFORE filters so counts remain accurate.\n\n' +
      '**Example:** `GET /api/departments/baby-products/search?q=shampoo&minRating=4&sortBy=rating`',
  })
  @ApiParam({ name: 'slug', description: 'Department slug or raw name', example: 'baby-products' })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Search query (title, brand, ASIN, slug)',
    example: 'shampoo',
  })
  @ApiQuery({ name: 'brand', required: false, description: 'Filter by brand name (partial match)' })
  @ApiQuery({
    name: 'subcategory',
    required: false,
    description: 'Filter by subcategory slug or name',
  })
  @ApiQuery({
    name: 'minPrice',
    required: false,
    type: Number,
    description: 'Minimum price filter',
  })
  @ApiQuery({
    name: 'maxPrice',
    required: false,
    type: Number,
    description: 'Maximum price filter',
  })
  @ApiQuery({
    name: 'minRating',
    required: false,
    type: Number,
    description: 'Minimum avg rating (e.g. 4)',
    example: 4,
  })
  @ApiQuery({
    name: 'inStock',
    required: false,
    type: Boolean,
    description: 'Only show in-stock products',
  })
  @ApiQuery({
    name: 'onSale',
    required: false,
    type: Boolean,
    description: 'Only show on-sale products',
  })
  @ApiQuery({
    name: 'prime',
    required: false,
    type: Boolean,
    description: 'Only show Prime-eligible products',
  })
  @ApiQuery({
    name: 'sortBy',
    required: false,
    enum: ['relevance', 'price_asc', 'price_desc', 'rating', 'reviews'],
    description: 'Sort order (default: relevance)',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20, description: 'Max 100' })
  async searchInDepartment(
    @Param('slug') slug: string,
    @Query('q') q?: string,
    @Query('brand') brand?: string,
    @Query('subcategory') subcategory?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('minRating') minRating?: string,
    @Query('inStock') inStock?: string,
    @Query('onSale') onSale?: string,
    @Query('prime') prime?: string,
    @Query('sortBy') sortBy?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.departmentsService.searchInDepartment(slug, {
      q,
      brand,
      subcategory,
      minPrice: minPrice !== undefined ? Number(minPrice) : undefined,
      maxPrice: maxPrice !== undefined ? Number(maxPrice) : undefined,
      minRating: minRating !== undefined ? Number(minRating) : undefined,
      inStock: inStock === 'true' ? true : undefined,
      onSale: onSale === 'true' ? true : undefined,
      prime: prime === 'true' ? true : undefined,
      sortBy: (sortBy as any) ?? 'relevance',
      page: page ? Math.max(1, Number(page)) : 1,
      limit: limit ? Math.min(100, Number(limit)) : 20,
    })
    return successResponse(data, { total: data.pagination.total })
  }

  /**
   * GET /api/departments/:slug/subcategories/:subSlug/products
   */
  @Get(':slug/subcategories/:subSlug/products')
  @ApiOperation({
    summary: 'Paginated products within a specific department subcategory',
    description: 'Returns products scoped to dept > subcat, sorted by rating desc.',
  })
  @ApiParam({ name: 'slug', description: 'Department slug or name' })
  @ApiParam({ name: 'subSlug', description: 'Subcategory slug or name' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  async findSubcategoryProducts(
    @Param('slug') slug: string,
    @Param('subSlug') subSlug: string,
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 20,
  ) {
    const data = await this.departmentsService.findSubcategory(slug, subSlug, {
      page: Number(page),
      limit: Math.min(Number(limit), 100),
    })
    return successResponse(data)
  }
}
