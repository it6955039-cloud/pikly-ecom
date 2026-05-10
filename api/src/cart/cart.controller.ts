// src/cart/cart.controller.ts
import {
  Controller, Get, Post, Patch, Delete, Body, Query, Param,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import {
  ApiTags, ApiOperation, ApiQuery, ApiParam, ApiBearerAuth, ApiBody,
} from '@nestjs/swagger'

import { CartService }   from './cart.service'
import { successResponse } from '../common/api-utils'
import {
  AddToCartDto, UpdateCartDto, ApplyCouponDto,
  MergeCartDto, BulkRemoveDto,
} from './dto/cart.dto'

import { RequireAuthGuard }     from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { OptionalJitGuard }     from '../identity/guards/optional-jit.guard'
import { OptionalUser, CurrentUserId } from '../identity/decorators/identity.decorators'
import { ResolvedIdentity }     from '../identity/ports/identity.port'

const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-:]{8,128}$/

const AUTH_NOTE =
  '**Auth:** Send `Authorization: Bearer <token>` for logged-in users. ' +
  'Guest users must omit the header and pass `sessionId` in body/query instead. ' +
  'The backend ignores any client-supplied `sessionId` when a valid token is present.'

@ApiTags('Cart')
@UseGuards(OptionalJitGuard)
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  private resolveSessionId(user: ResolvedIdentity | null, clientSid?: string): string {
    if (user) return `user:${user.internalId}`
    const sid = clientSid ?? ''
    if (!sid || !SESSION_ID_REGEX.test(sid)) {
      throw new BadRequestException({
        code:    'INVALID_SESSION',
        message:
          'Send Authorization: Bearer <token> for authenticated requests. ' +
          'Guest users must supply a valid sessionId (8–128 alphanumeric chars).',
      })
    }
    return sid
  }

  @Get()
  @ApiOperation({ summary: 'Get cart contents', description: `Returns full cart with items and computed summary.\n\n${AUTH_NOTE}` })
  @ApiQuery({ name: 'sessionId', required: false, description: '⚠️ Guest only — ignored when Authorization header is present.' })
  async getCart(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    const sessionId = user ? `user:${user.internalId}` : this.resolveSessionId(null, sid)
    return successResponse(await this.cartService.getCart(sessionId))
  }

  @Get('summary')
  @ApiOperation({ summary: 'Lightweight cart summary — use for navbar badge', description: `Returns only itemCount + totals.\n\n${AUTH_NOTE}` })
  @ApiQuery({ name: 'sessionId', required: false, description: '⚠️ Guest only — ignored when Authorization header is present.' })
  async getSummary(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    return successResponse(await this.cartService.getSummary(sessionId))
  }

  @Post('add')
  @ApiOperation({ summary: 'Add item to cart', description: `Adds a product. If item already exists, quantity increments (capped at 10).\n\n${AUTH_NOTE}` })
  async addItem(
    @OptionalUser() user: ResolvedIdentity | null,
    @Body() dto: AddToCartDto,
  ) {
    const sessionId = this.resolveSessionId(user, dto.sessionId)
    return successResponse(await this.cartService.addItem({ ...dto, sessionId }, user?.internalId))
  }

  @Patch('update')
  @ApiOperation({ summary: 'Update item quantity (quantity 0 = remove item)', description: AUTH_NOTE })
  async updateItem(
    @OptionalUser() user: ResolvedIdentity | null,
    @Body() dto: UpdateCartDto,
  ) {
    const sessionId = this.resolveSessionId(user, dto.sessionId)
    return successResponse(await this.cartService.updateItem({ ...dto, sessionId }))
  }

  @Delete('items/:productId')
  @ApiOperation({
    summary: 'Remove a single item from the cart',
    description: `Removes one product. To remove multiple at once use DELETE /cart/items (bulk).\n\n${AUTH_NOTE}`,
  })
  @ApiParam({ name: 'productId', description: 'Product ASIN or slug' })
  @ApiQuery({ name: 'variantId', required: false })
  @ApiQuery({ name: 'sessionId', required: false, description: '⚠️ Guest only.' })
  async removeItem(
    @OptionalUser() user: ResolvedIdentity | null,
    @Param('productId') productId: string,
    @Query('sessionId') sid?: string,
    @Query('variantId') variantId?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    return successResponse(await this.cartService.removeItem({ productId, variantId, sessionId }))
  }

  @Delete('items')
  @ApiOperation({
    summary: 'Remove multiple items from the cart in one call (bulk)',
    description: `Removes 1–50 items atomically.\n\n${AUTH_NOTE}`,
  })
  @ApiBody({ type: BulkRemoveDto })
  async bulkRemoveItems(
    @OptionalUser() user: ResolvedIdentity | null,
    @Body() dto: BulkRemoveDto,
  ) {
    const sessionId = this.resolveSessionId(user, dto.sessionId)
    return successResponse(await this.cartService.bulkRemoveItems({ items: dto.items, sessionId }))
  }

  @Post('apply-coupon')
  @ApiOperation({
    summary: 'Apply a coupon code to the cart',
    description: `Error codes: \`INVALID_COUPON\` \`COUPON_EXHAUSTED\` \`COUPON_ALREADY_USED\` \`COUPON_MIN_ORDER\`\n\n${AUTH_NOTE}`,
  })
  async applyCoupon(
    @OptionalUser() user: ResolvedIdentity | null,
    @Body() dto: ApplyCouponDto,
  ) {
    const sessionId = this.resolveSessionId(user, dto.sessionId)
    return successResponse(await this.cartService.applyCoupon({ ...dto, sessionId }, user?.internalId ?? null))
  }

  @Delete('coupon')
  @ApiOperation({ summary: 'Remove applied coupon from the cart', description: AUTH_NOTE })
  @ApiQuery({ name: 'sessionId', required: false, description: '⚠️ Guest only.' })
  async removeCoupon(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    return successResponse(await this.cartService.removeCoupon(sessionId))
  }

  @Post('merge')
  @UseGuards(RequireAuthGuard, JitProvisioningGuard)
  @ApiOperation({
    summary: 'Merge guest cart into user cart — call once after login',
    description: '**Auth required.** Call once after login then remove `gid` from localStorage.',
  })
  async mergeCart(
    @CurrentUserId() userId: string,
    @Body() dto: MergeCartDto,
  ) {
    return successResponse(await this.cartService.mergeCart({ ...dto, userId }))
  }

  @Delete()
  @ApiOperation({
    summary: 'Clear all items from the cart',
    description: `Called automatically after successful order — no need to call manually.\n\n${AUTH_NOTE}`,
  })
  @ApiQuery({ name: 'sessionId', required: false, description: '⚠️ Guest only.' })
  async clearCart(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    await this.cartService.clearCart(sessionId)
    return successResponse({ cleared: true })
  }
}
