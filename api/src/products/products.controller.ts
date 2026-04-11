import {
  Controller, Get, Post, Param, Query,
  UseGuards, Request, Body,
} from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'
import {
  ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBearerAuth,
} from '@nestjs/swagger'
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard'
import { ProductsService }   from './products.service'
import { FilterProductsDto } from './dto/filter-products.dto'
import { ReviewQueryDto }    from './dto/review-query.dto'
import { SubmitReviewDto }   from './dto/submit-review.dto'
import { successResponse, paginatedResponse } from '../common/api-utils'

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ── Curated lists ──────────────────────────────────────────────────────────

  @Get('featured')
  @ApiOperation({ summary: 'Amazon\'s Choice + featured products' })
  getFeatured(@Query('limit') limit = 20) {
    return successResponse(this.productsService.getFeatured(Number(limit)))
  }

  @Get('bestsellers')
  @ApiOperation({ summary: 'Best Sellers' })
  getBestSellers(@Query('limit') limit = 20) {
    return successResponse(this.productsService.getBestSellers(Number(limit)))
  }

  @Get('new-arrivals')
  @ApiOperation({ summary: 'New Arrivals / New Releases' })
  getNewArrivals(@Query('limit') limit = 20) {
    return successResponse(this.productsService.getNewArrivals(Number(limit)))
  }

  @Get('trending')
  @ApiOperation({ summary: 'Trending — 10K+ bought in past month' })
  getTrending(@Query('limit') limit = 20) {
    return successResponse(this.productsService.getTrending(Number(limit)))
  }

  @Get('top-rated')
  @ApiOperation({ summary: 'Top Rated — 4.5★+ with 100+ reviews' })
  getTopRated(@Query('limit') limit = 20) {
    return successResponse(this.productsService.getTopRated(Number(limit)))
  }

  @Get('on-sale')
  @ApiOperation({ summary: 'On Sale — 10%+ discount' })
  getOnSale(@Query('limit') limit = 20) {
    return successResponse(this.productsService.getOnSale(Number(limit)))
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  @Get('search/suggestions')
  @ApiOperation({ summary: 'Autocomplete suggestions (Fuse.js fallback)' })
  @ApiQuery({ name: 'q', required: true })
  getSuggestions(@Query('q') q: string, @Query('limit') limit = 8) {
    return successResponse(this.productsService.getSuggestions(q, Number(limit)))
  }

  // ── Main list (Algolia-powered) ────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Product list with Algolia faceting and filtering' })
  async findAll(@Query() query: FilterProductsDto) {
    const { data, cacheHit } = await this.productsService.findAll(query)
    return { ...data, meta: { ...data.meta, cacheHit } }
  }

  // ── Product detail ─────────────────────────────────────────────────────────

  @Get(':slug')
  @ApiOperation({ summary: 'Product detail by slug, ASIN, or internal ID' })
  @ApiParam({ name: 'slug', description: 'Product slug, ASIN, or internal ID' })
  async findOne(@Param('slug') slug: string) {
    return successResponse(await this.productsService.findOne(slug))
  }

  // ── Reviews ────────────────────────────────────────────────────────────────

  @Get(':slug/reviews')
  @ApiOperation({ summary: 'Paginated reviews for a product' })
  @ApiParam({ name: 'slug', description: 'Product slug or ASIN' })
  async findReviews(@Param('slug') slug: string, @Query() query: ReviewQueryDto) {
    return successResponse(await this.productsService.findReviews(slug, query))
  }

  @Post(':slug/reviews')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a review (requires auth)' })
  async submitReview(
    @Param('slug') slug: string,
    @Request() req: any,
    @Body() dto: SubmitReviewDto,
  ) {
    return successResponse(
      await this.productsService.submitReview(slug, req.user.userId, dto),
    )
  }
}