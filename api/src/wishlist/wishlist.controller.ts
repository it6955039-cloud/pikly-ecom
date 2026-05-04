/**
 * @file wishlist.controller.ts  ← REPLACE src/wishlist/wishlist.controller.ts
 *
 * Wishlist Controller — migrated from AuthGuard('jwt') → IAL guards.
 *
 * DIFF vs original:
 *   - @UseGuards(AuthGuard('jwt'))  → @UseGuards(RequireAuthGuard, JitProvisioningGuard)
 *   - @Request() req: any           → @CurrentUserId() userId: string
 *   - req.user.userId               → userId
 */

import { Controller, Get, Post, Delete, Body, Query, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth }        from '@nestjs/swagger'

import { WishlistService }        from './wishlist.service'
import { successResponse }        from '../common/api-utils'
import { RequireAuthGuard }       from '../identity/guards/identity.guards'
import { JitProvisioningGuard }   from '../identity/jit/jit-provisioning.guard'
import { CurrentUserId }          from '../identity/decorators/identity.decorators'

@ApiTags('Wishlist')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, JitProvisioningGuard)
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  @ApiOperation({ summary: "Get the authenticated user's wishlist" })
  async getWishlist(@CurrentUserId() userId: string) {
    return successResponse(await this.wishlistService.getWishlist(userId))
  }

  @Post('toggle')
  @ApiOperation({ summary: 'Add or remove a product from the wishlist' })
  async toggle(
    @CurrentUserId() userId: string,
    @Body() body: { productId: string },
  ) {
    return successResponse(await this.wishlistService.toggle(userId, body.productId))
  }

  @Get('check')
  @ApiOperation({ summary: 'Check whether a product is in the wishlist' })
  @ApiQuery({ name: 'productId', required: true })
  async check(
    @CurrentUserId() userId: string,
    @Query('productId') productId: string,
  ) {
    return successResponse(await this.wishlistService.check(userId, productId))
  }
}
