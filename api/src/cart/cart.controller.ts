import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  UseGuards,
  Request,
  BadRequestException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiBearerAuth } from '@nestjs/swagger'
import { CartService } from './cart.service'
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard'
import { AuthGuard } from '@nestjs/passport'
import { successResponse } from '../common/api-utils'
import { AddToCartDto, UpdateCartDto, ApplyCouponDto, MergeCartDto } from './dto/cart.dto'

// Maximum length and character set for a guest session ID.
// UUIDs (36 chars), nanoids (21 chars), and custom alphanumeric IDs all pass.
const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-:]{8,128}$/

@ApiTags('Cart')
@UseGuards(OptionalJwtGuard) // SEC-04: validates JWT when present, passes through for guests
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  // ── Session ID resolution ────────────────────────────────────────────────
  // This is the core of the SEC-04 fix. When a valid JWT is present, we
  // derive the session ID from the verified user identity and ignore whatever
  // the client sent — an authenticated user's cart is always identified by
  // their user ID, so they cannot access another user's cart by guessing or
  // crafting a session ID. For guest users we validate the client-provided
  // value to ensure it is a reasonable format (no path traversal characters,
  // bounded length) before using it as a MongoDB query key.
  private resolveSessionId(req: any, clientSid?: string): string {
    if (req.user?.userId) {
      // Authenticated: always use the verified identity — ignore client value
      return `user:${req.user.userId}`
    }

    // Guest: validate the client-provided session ID
    const sid = req.headers['x-session-id'] ?? clientSid ?? ''
    if (!sid || !SESSION_ID_REGEX.test(sid)) {
      throw new BadRequestException({
        code: 'INVALID_SESSION',
        message:
          'A valid X-Session-ID header (8–128 alphanumeric characters) is required for guest carts.',
      })
    }
    return sid
  }

  @Get()
  @ApiOperation({ summary: 'Get cart contents' })
  @ApiQuery({
    name: 'sessionId',
    required: false,
    description: 'Guest session ID (ignored when authenticated)',
  })
  async getCart(@Request() req: any, @Query('sessionId') sid?: string) {
    const sessionId = this.resolveSessionId(req, sid)
    const data = await this.cartService.getCart(sessionId)
    return successResponse(data)
  }

  @Post('add')
  @ApiOperation({ summary: 'Add item to cart' })
  async addItem(@Request() req: any, @Body() dto: AddToCartDto) {
    const sessionId = this.resolveSessionId(req, dto.sessionId)
    const data = await this.cartService.addItem({ ...dto, sessionId })
    return successResponse(data)
  }

  @Patch('update')
  @ApiOperation({ summary: 'Update item quantity (0 = remove)' })
  async updateItem(@Request() req: any, @Body() dto: UpdateCartDto) {
    const sessionId = this.resolveSessionId(req, dto.sessionId)
    const data = await this.cartService.updateItem({ ...dto, sessionId })
    return successResponse(data)
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove a specific item from the cart' })
  @ApiParam({ name: 'productId' })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'variantId', required: false })
  async removeItem(
    @Request() req: any,
    @Param('productId') productId: string,
    @Query('sessionId') sid?: string,
    @Query('variantId') variantId?: string,
  ) {
    const sessionId = this.resolveSessionId(req, sid)
    const data = await this.cartService.removeItem({ productId, variantId, sessionId })
    return successResponse(data)
  }

  @Post('apply-coupon')
  @ApiOperation({ summary: 'Apply a coupon code to the cart' })
  async applyCoupon(@Request() req: any, @Body() dto: ApplyCouponDto) {
    const sessionId = this.resolveSessionId(req, dto.sessionId)
    // Pass the authenticated userId so per-user coupon usage can be checked
    const userId = req.user?.userId ?? null
    const data = await this.cartService.applyCoupon({ ...dto, sessionId }, userId)
    return successResponse(data)
  }

  @Delete('coupon')
  @ApiOperation({ summary: 'Remove applied coupon from the cart' })
  @ApiQuery({ name: 'sessionId', required: false })
  async removeCoupon(@Request() req: any, @Query('sessionId') sid?: string) {
    const sessionId = this.resolveSessionId(req, sid)
    const data = await this.cartService.removeCoupon(sessionId)
    return successResponse(data)
  }

  // mergeCart requires authentication — the user must be logged in to have a
  // persistent user cart to merge into. AuthGuard('jwt') provides hard auth here.
  @Post('merge')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Merge guest cart into authenticated user cart after login' })
  async mergeCart(@Request() req: any, @Body() dto: MergeCartDto) {
    const userSessionId = `user:${req.user.userId}`
    const data = await this.cartService.mergeCart({
      ...dto,
      userId: userSessionId, // SEC-04: use derived session, not caller-supplied userId
    })
    return successResponse(data)
  }

  @Get('summary')
  @ApiOperation({ summary: 'Lightweight cart summary (item count + total only)' })
  @ApiQuery({ name: 'sessionId', required: false })
  async getSummary(@Request() req: any, @Query('sessionId') sid?: string) {
    const sessionId = this.resolveSessionId(req, sid)
    const data = await this.cartService.getSummary(sessionId)
    return successResponse(data)
  }

  @Delete()
  @ApiOperation({ summary: 'Clear all items from cart' })
  @ApiQuery({ name: 'sessionId', required: false })
  async clearCart(@Request() req: any, @Query('sessionId') sid?: string) {
    const sessionId = this.resolveSessionId(req, sid)
    await this.cartService.clearCart(sessionId)
    return successResponse({ cleared: true })
  }
}
