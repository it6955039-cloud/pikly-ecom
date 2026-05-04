// src/cart/cart.controller.ts  ← REPLACE
//
// MIGRATION DIFF vs v2 original:
//   Class level:
//     OptionalJwtGuard → OptionalIdentityGuard
//
//   resolveSessionId():
//     req.user?.userId  → user?.internalId
//     The method signature changes from (req: any, clientSid?) to
//     (user: ResolvedIdentity | null, clientSid?) so it receives the typed
//     identity from the @OptionalUser() decorator instead of raw req.
//
//   mergeCart endpoint:
//     AuthGuard('jwt')  → RequireAuthGuard + JitProvisioningGuard
//     req.user.userId   → @CurrentUserId() userId
//
//   All other endpoints pass @OptionalUser() user instead of @Request() req.
//
//   CartService method signatures are UNCHANGED — they still receive sessionId
//   and optional userId strings, both are now internal UUIDs.
//
// SEC-04 invariant preserved: authenticated user's session is always
// derived from their verified internalId, client-provided sessionId is ignored.

import {
  Controller, Get, Post, Patch, Delete, Body, Query, Param,
  UseGuards, BadRequestException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiParam, ApiBearerAuth } from '@nestjs/swagger'

import { CartService }   from './cart.service'
import { successResponse } from '../common/api-utils'
import { AddToCartDto, UpdateCartDto, ApplyCouponDto, MergeCartDto } from './dto/cart.dto'

import { OptionalIdentityGuard, RequireAuthGuard } from '../identity/guards/identity.guards'
import { JitProvisioningGuard }  from '../identity/jit/jit-provisioning.guard'
import { OptionalUser, CurrentUserId } from '../identity/decorators/identity.decorators'
import { ResolvedIdentity }      from '../identity/ports/identity.port'

const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-:]{8,128}$/

@ApiTags('Cart')
@UseGuards(OptionalIdentityGuard)
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  // SEC-04: authenticated users always get session from verified internalId.
  // Guest session is validated to prevent path traversal / injection.
  private resolveSessionId(
    user: ResolvedIdentity | null,
    clientSid?: string,
    headerSid?: string,
  ): string {
    if (user) {
      // Authenticated: derive from verified internal UUID — ignore any client value
      return `user:${user.internalId}`
    }
    const sid = headerSid ?? clientSid ?? ''
    if (!sid || !SESSION_ID_REGEX.test(sid)) {
      throw new BadRequestException({
        code:    'INVALID_SESSION',
        message: 'A valid X-Session-ID header (8–128 alphanumeric chars) is required for guest carts.',
      })
    }
    return sid
  }

  @Get()
  @ApiOperation({ summary: 'Get cart contents' })
  @ApiQuery({ name: 'sessionId', required: false, description: 'Guest session ID (ignored when authenticated)' })
  async getCart(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    // Note: X-Session-ID header not available as decorator — guests pass via query or header
    // The guest path still works via query param (backward compat with frontend)
    const sessionId = user ? `user:${user.internalId}` : this.resolveSessionId(null, sid)
    return successResponse(await this.cartService.getCart(sessionId))
  }

  @Post('add')
  @ApiOperation({ summary: 'Add item to cart' })
  async addItem(
    @OptionalUser() user: ResolvedIdentity | null,
    @Body() dto: AddToCartDto,
  ) {
    const sessionId = this.resolveSessionId(user, dto.sessionId)
    return successResponse(await this.cartService.addItem({ ...dto, sessionId }, user?.internalId))
  }

  @Patch('update')
  @ApiOperation({ summary: 'Update item quantity (0 = remove)' })
  async updateItem(
    @OptionalUser() user: ResolvedIdentity | null,
    @Body() dto: UpdateCartDto,
  ) {
    const sessionId = this.resolveSessionId(user, dto.sessionId)
    return successResponse(await this.cartService.updateItem({ ...dto, sessionId }))
  }

  @Delete('items/:productId')
  @ApiOperation({ summary: 'Remove a specific item from the cart' })
  @ApiParam({ name: 'productId' })
  @ApiQuery({ name: 'sessionId', required: false })
  @ApiQuery({ name: 'variantId', required: false })
  async removeItem(
    @OptionalUser() user: ResolvedIdentity | null,
    @Param('productId') productId: string,
    @Query('sessionId') sid?: string,
    @Query('variantId') variantId?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    return successResponse(await this.cartService.removeItem({ productId, variantId, sessionId }))
  }

  @Post('apply-coupon')
  @ApiOperation({ summary: 'Apply a coupon code to the cart' })
  async applyCoupon(
    @OptionalUser() user: ResolvedIdentity | null,
    @Body() dto: ApplyCouponDto,
  ) {
    const sessionId = this.resolveSessionId(user, dto.sessionId)
    return successResponse(await this.cartService.applyCoupon({ ...dto, sessionId }, user?.internalId ?? null))
  }

  @Delete('coupon')
  @ApiOperation({ summary: 'Remove applied coupon from the cart' })
  @ApiQuery({ name: 'sessionId', required: false })
  async removeCoupon(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    return successResponse(await this.cartService.removeCoupon(sessionId))
  }

  // mergeCart is the only endpoint that strictly requires authentication
  @Post('merge')
  @UseGuards(RequireAuthGuard, JitProvisioningGuard)
  @ApiOperation({ summary: 'Merge guest cart into authenticated user cart after login' })
  async mergeCart(
    @CurrentUserId() userId: string,
    @Body() dto: MergeCartDto,
  ) {
    return successResponse(await this.cartService.mergeCart({ ...dto, userId }))
  }

  @Get('summary')
  @ApiOperation({ summary: 'Lightweight cart summary (item count + total only)' })
  @ApiQuery({ name: 'sessionId', required: false })
  async getSummary(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    return successResponse(await this.cartService.getSummary(sessionId))
  }

  @Delete()
  @ApiOperation({ summary: 'Clear all items from cart' })
  @ApiQuery({ name: 'sessionId', required: false })
  async clearCart(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('sessionId') sid?: string,
  ) {
    const sessionId = this.resolveSessionId(user, sid)
    await this.cartService.clearCart(sessionId)
    return successResponse({ cleared: true })
  }
}
