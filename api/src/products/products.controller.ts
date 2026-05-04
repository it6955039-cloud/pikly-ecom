/**
 * @file products.controller.ts  ← REPLACE src/products/products.controller.ts
 *
 * Products Controller — partial migration: only submitReview requires auth.
 *
 * DIFF vs original:
 *   submitReview:
 *     - @UseGuards(AuthGuard('jwt'))  → @UseGuards(RequireAuthGuard, JitProvisioningGuard)
 *     - @Request() req: any           → @CurrentUserId() userId: string
 *     - req.user.userId               → userId
 *
 *   All other endpoints are public or use OptionalIdentityGuard — no change in logic.
 */

import {
  Controller, Get, Post, Param, Query, UseGuards, Body,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger'

import { ProductsService }         from './products.service'
import { successResponse }         from '../common/api-utils'
import { FilterProductsDto }       from './dto/filter-products.dto'
import { SubmitReviewDto }         from './dto/submit-review.dto'
import { ReviewQueryDto }          from './dto/review-query.dto'
import { OptionalIdentityGuard }   from '../identity/guards/identity.guards'
import { RequireAuthGuard }        from '../identity/guards/identity.guards'
import { JitProvisioningGuard }    from '../identity/jit/jit-provisioning.guard'
import { CurrentUserId, OptionalUser } from '../identity/decorators/identity.decorators'
import { ResolvedIdentity }        from '../identity/ports/identity.port'

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ── Public endpoints — no auth required ────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List / filter / search products' })
  async findAll(@Query() filters: FilterProductsDto) {
    return successResponse(await this.productsService.findAll(filters))
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get single product by slug' })
  @ApiParam({ name: 'slug' })
  async findOne(@Param('slug') slug: string) {
    return successResponse(await this.productsService.findOne(slug))
  }

  @Get(':slug/reviews')
  @ApiOperation({ summary: 'Get reviews for a product' })
  @ApiParam({ name: 'slug' })
  async getReviews(
    @Param('slug') slug: string,
    @Query() query: ReviewQueryDto,
  ) {
    return successResponse(await this.productsService.getReviews(slug, query))
  }

  // ── Authenticated — submit review ──────────────────────────────────────────

  @Post(':slug/reviews')
  @ApiBearerAuth()
  @UseGuards(RequireAuthGuard, JitProvisioningGuard)
  @ApiOperation({ summary: 'Submit a product review (requires auth)' })
  @ApiParam({ name: 'slug' })
  async submitReview(
    @Param('slug') slug: string,
    @CurrentUserId() userId: string,
    @Body() dto: SubmitReviewDto,
  ) {
    return successResponse(await this.productsService.submitReview(slug, userId, dto))
  }
}
