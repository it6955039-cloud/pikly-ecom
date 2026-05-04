/**
 * @file recently-viewed.controller.ts  ← REPLACE src/recently-viewed/recently-viewed.controller.ts
 *
 * DIFF vs original:
 *   - @UseGuards(AuthGuard('jwt')) → @UseGuards(RequireAuthGuard, JitProvisioningGuard)
 *   - @Request() req: any          → @CurrentUserId() userId: string
 *   - req.user.userId              → userId
 */

import {
  Controller, Post, Get, Body, Query, UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger'

import { RecentlyViewedService }  from './recently-viewed.service'
import { successResponse }        from '../common/api-utils'
import { RequireAuthGuard }       from '../identity/guards/identity.guards'
import { JitProvisioningGuard }   from '../identity/jit/jit-provisioning.guard'
import { CurrentUserId }          from '../identity/decorators/identity.decorators'

@ApiTags('Recently Viewed')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, JitProvisioningGuard)
@Controller('recently-viewed')
export class RecentlyViewedController {
  constructor(private readonly recentlyViewedService: RecentlyViewedService) {}

  @Post()
  @ApiOperation({ summary: 'Track a product view for the authenticated user' })
  async track(
    @CurrentUserId() userId: string,
    @Body() body: { productId: string },
  ) {
    return successResponse(
      await this.recentlyViewedService.track(userId, body.productId),
    )
  }

  @Get()
  @ApiOperation({
    summary: 'Get recently viewed products — supports offset (page) and cursor pagination',
  })
  @ApiQuery({ name: 'page',   required: false, description: 'Page number (use page OR cursor)' })
  @ApiQuery({ name: 'limit',  required: false, description: 'Items per page (default: 10)' })
  @ApiQuery({ name: 'cursor', required: false, description: 'Cursor from previous response' })
  async getRecent(
    @CurrentUserId() userId: string,
    @Query('page')   page?:   number,
    @Query('limit')  limit?:  number,
    @Query('cursor') cursor?: string,
  ) {
    return successResponse(
      await this.recentlyViewedService.getRecent(userId, {
        page:   page   ? Number(page)  : undefined,
        limit:  limit  ? Number(limit) : undefined,
        cursor: cursor ?? undefined,
      }),
    )
  }
}
