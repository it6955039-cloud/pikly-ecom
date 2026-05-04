// src/webhooks/webhook.controller.ts  ← REPLACE
//
// MIGRATION DIFF vs v2 original:
//   - AuthGuard('jwt') + RolesGuard + @Roles('admin')
//     → RequireRoleGuard + JitProvisioningGuard + @RequireRole('admin')
//   - @Request() req: any → @CurrentUserId() userId: string
//   - req.user.userId     → userId
//
// WebhookService method signatures are UNCHANGED — they still receive userId.
// SEC-01: restricted to admins (unchanged from v2).

import { Controller, Post, Get, Delete, Body, Param, UseGuards, HttpCode, HttpStatus } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger'
import { IsString, IsArray, IsUrl, IsIn, ArrayMinSize, ArrayMaxSize } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

import { WebhookService } from './webhook.service'
import { successResponse } from '../common/api-utils'
import { RequireRoleGuard }    from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole }         from '../identity/guards/identity.guards'
import { CurrentUserId }       from '../identity/decorators/identity.decorators'

const VALID_EVENTS = [
  'order.created', 'order.status_changed', 'order.cancelled',
  'order.shipped', 'order.delivered',
]

class RegisterWebhookDto {
  @ApiProperty({ description: 'HTTPS webhook endpoint URL', example: 'https://my-app.com/hooks' })
  @IsUrl({ require_tld: true, protocols: ['https'], require_protocol: true })
  url: string

  @ApiProperty({ type: [String], enum: VALID_EVENTS })
  @IsArray()
  @IsIn(VALID_EVENTS, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(VALID_EVENTS.length)
  events: string[]
}

@ApiTags('Webhooks')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @ApiOperation({ summary: '[Admin] Register a webhook endpoint (HTTPS only)' })
  async register(
    @CurrentUserId() userId: string,
    @Body() dto: RegisterWebhookDto,
  ) {
    return successResponse(await this.webhookService.register(userId, dto.url, dto.events))
  }

  @Get()
  @ApiOperation({ summary: '[Admin] List registered webhooks (secret redacted)' })
  async list(@CurrentUserId() userId: string) {
    return successResponse(await this.webhookService.list(userId))
  }

  @Delete(':id')
  @ApiOperation({ summary: '[Admin] Delete a webhook by ID' })
  @ApiParam({ name: 'id' })
  async remove(
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    return successResponse(await this.webhookService.delete(id, userId))
  }
}
