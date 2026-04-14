import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { OrdersService } from './orders.service'
import { CreateOrderDto } from './dto/create-order.dto'
import { successResponse } from '../common/api-utils'

@ApiTags('Orders')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('create')
  @ApiOperation({ summary: 'Create order from cart (DES-03: supports Idempotency-Key)' })
  async create(@Request() req: any, @Body() dto: CreateOrderDto) {
    const data = await this.ordersService.createOrder(req.user.userId, dto)
    return successResponse(data)
  }

  // FEAT-02: pre-checkout shipping cost endpoint
  @Get('shipping-estimate')
  @ApiOperation({ summary: 'Calculate shipping cost before placing order' })
  @ApiQuery({ name: 'addressId', required: true })
  async shippingEstimate(
    @Request() req: any,
    @Query('addressId') addressId: string,
  ) {
    // For authenticated users the cart is stored under session_id = "user:{UUID}".
    // Deriving the sessionId from the verified JWT (like CartController does) ensures
    // we always look up the right cart, regardless of what the client sends.
    const sessionId = `user:${req.user.userId}`
    const data = await this.ordersService.calculateShipping(sessionId, addressId, req.user.userId)
    return successResponse(data)
  }

  @Get()
  @ApiOperation({
    summary: 'Get all orders for the authenticated user (SVC-02: DB-level pagination)',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'status', required: false })
  async getUserOrders(
    @Request() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
  ) {
    const data = await this.ordersService.getUserOrders(req.user.userId, { page, limit, status })
    return successResponse(data)
  }

  @Get(':orderId')
  @ApiOperation({ summary: 'Get single order' })
  @ApiParam({ name: 'orderId' })
  async getOrder(@Request() req: any, @Param('orderId') orderId: string) {
    return successResponse(await this.ordersService.getOrder(orderId, req.user.userId))
  }

  @Patch(':orderId/cancel')
  @ApiOperation({ summary: 'Cancel a pending/confirmed order' })
  @ApiParam({ name: 'orderId' })
  async cancelOrder(@Request() req: any, @Param('orderId') orderId: string) {
    return successResponse(await this.ordersService.cancelOrder(orderId, req.user.userId))
  }

  @Get(':orderId/track')
  @ApiOperation({ summary: 'Track order status with full timeline' })
  @ApiParam({ name: 'orderId' })
  async trackOrder(@Request() req: any, @Param('orderId') orderId: string) {
    return successResponse(await this.ordersService.trackOrder(orderId, req.user.userId))
  }
}
