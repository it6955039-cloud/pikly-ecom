/**
 * @file orders.controller.ts  ← REPLACE src/orders/orders.controller.ts
 *
 * Orders Controller — migrated from AuthGuard('jwt') → IAL guards.
 *
 * DIFF SUMMARY vs original:
 *   - @UseGuards(AuthGuard('jwt')) → @UseGuards(RequireAuthGuard, JitProvisioningGuard)
 *   - @Request() req: any          → @CurrentUserId() userId: string
 *   - req.user.userId              → userId (typed string UUID)
 *   - Idempotency-Key header       → unchanged (preserved from original)
 *
 * The Orders service is UNTOUCHED — it still receives a UUID string and
 * performs all queries against store.orders WHERE user_id = $1.
 */

import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Headers,
  ParseIntPipe,
  DefaultValuePipe,
  Optional,
} from '@nestjs/common'
import {
  ApiTags, ApiOperation, ApiBearerAuth,
  ApiParam, ApiQuery, ApiHeader,
} from '@nestjs/swagger'

import { OrdersService }          from './orders.service'
import { CreateOrderDto }         from './dto/create-order.dto'
import { successResponse }        from '../common/api-utils'
import { RequireAuthGuard }       from '../identity/guards/identity.guards'
import { JitProvisioningGuard }   from '../identity/jit/jit-provisioning.guard'
import { CurrentUserId }          from '../identity/decorators/identity.decorators'

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, JitProvisioningGuard)
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /**
   * DES-03: Idempotency-Key header is forwarded to the service unchanged.
   * The service uses it with Redis to prevent duplicate order submissions
   * on network retry — this behaviour is completely independent of auth.
   */
  @Post('create')
  @ApiOperation({ summary: 'Create order from cart (DES-03: supports Idempotency-Key)' })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'UUID to prevent duplicate orders on retry' })
  async create(
    @CurrentUserId() userId: string,
    @Body() dto: CreateOrderDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const data = await this.ordersService.createOrder(userId, dto, idempotencyKey)
    return successResponse(data)
  }

  @Get('shipping-estimate')
  @ApiOperation({ summary: 'Calculate shipping cost before placing order' })
  @ApiQuery({ name: 'addressId', required: true })
  async shippingEstimate(
    @CurrentUserId() userId: string,
    @Query('addressId') addressId: string,
  ) {
    // Cart is stored under session_id = "user:{UUID}" — identical to original logic
    const sessionId = `user:${userId}`
    const data = await this.ordersService.calculateShipping(sessionId, addressId, userId)
    return successResponse(data)
  }

  @Get()
  @ApiOperation({ summary: 'Get all orders for the authenticated user (SVC-02: paginated)' })
  @ApiQuery({ name: 'page',   required: false })
  @ApiQuery({ name: 'limit',  required: false })
  @ApiQuery({ name: 'status', required: false })
  async getUserOrders(
    @CurrentUserId() userId: string,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    const data = await this.ordersService.getUserOrders(userId, { page, limit, status })
    return successResponse(data)
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Get single order' })
  @ApiParam({ name: 'orderId' })
  async getOrder(
    @CurrentUserId() userId: string,
    @Param('orderId') orderId: string,
  ) {
    return successResponse(await this.ordersService.getOrder(orderId, userId))
  }

  @Patch(':orderId/cancel')
  @ApiOperation({ summary: 'Cancel a pending/confirmed order' })
  @ApiParam({ name: 'orderId' })
  async cancelOrder(
    @CurrentUserId() userId: string,
    @Param('orderId') orderId: string,
  ) {
    return successResponse(await this.ordersService.cancelOrder(orderId, userId))
  }

  @Get(':orderId/track')
  @ApiOperation({ summary: 'Track order status with full timeline' })
  @ApiParam({ name: 'orderId' })
  async trackOrder(
    @CurrentUserId() userId: string,
    @Param('orderId') orderId: string,
  ) {
    return successResponse(await this.ordersService.trackOrder(orderId, userId))
  }
}
