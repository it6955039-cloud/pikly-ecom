import { Controller, Post, Get, Body, Query, UseGuards, Request } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { RecentlyViewedService } from './recently-viewed.service'
import { successResponse } from '../common/api-utils'

// Requires auth so userId is derived from the JWT rather than a query param.
@ApiTags('Recently Viewed')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('recently-viewed')
export class RecentlyViewedController {
  constructor(private readonly recentlyViewedService: RecentlyViewedService) {}

  @Post()
  @ApiOperation({ summary: 'Track a product view for the authenticated user' })
  async track(@Request() req: any, @Body() body: { productId: string }) {
    const data = await this.recentlyViewedService.track(req.user.userId, body.productId)
    return successResponse(data)
  }

  @Get()
  @ApiOperation({
    summary: 'Get recently viewed products — supports offset (page) and cursor pagination',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number — use either page OR cursor, not both',
  })
  @ApiQuery({ name: 'limit', required: false, description: 'Items per page (default: 10)' })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Cursor from previous response for cursor pagination',
  })
  async getRecent(
    @Request() req: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    const data = await this.recentlyViewedService.getRecent(req.user.userId, {
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? undefined,
    })
    return successResponse(data)
  }
}
