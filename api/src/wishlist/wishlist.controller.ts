import { Controller, Get, Post, Body, Query, UseGuards, Request } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { WishlistService } from './wishlist.service'
import { successResponse } from '../common/api-utils'

// All wishlist routes require authentication. userId is derived from the JWT
// token, not from a client-supplied query parameter, to prevent one user from
// reading or modifying another user's wishlist.
@ApiTags('Wishlist')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  @ApiOperation({ summary: "Get the authenticated user's wishlist" })
  async getWishlist(@Request() req: any) {
    const data = await this.wishlistService.getWishlist(req.user.userId)
    return successResponse(data)
  }

  @Post('toggle')
  @ApiOperation({ summary: 'Add or remove a product from the wishlist' })
  async toggle(@Request() req: any, @Body() body: { productId: string }) {
    const data = await this.wishlistService.toggle(req.user.userId, body.productId)
    return successResponse(data)
  }

  @Get('check')
  @ApiOperation({ summary: 'Check whether a product is in the wishlist' })
  @ApiQuery({ name: 'productId', required: true })
  async check(@Request() req: any, @Query('productId') productId: string) {
    const data = await this.wishlistService.check(req.user.userId, productId)
    return successResponse(data)
  }
}
