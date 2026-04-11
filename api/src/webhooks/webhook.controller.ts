import { Controller, Post, Get, Delete, Body, Param, UseGuards, Request } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger'
import { IsString, IsArray, IsUrl, IsIn, ArrayMinSize, ArrayMaxSize } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { WebhookService } from './webhook.service'
import { successResponse } from '../common/api-utils'

const VALID_EVENTS = [
  'order.created',
  'order.status_changed',
  'order.cancelled',
  'order.shipped',
  'order.delivered',
]

class RegisterWebhookDto {
  // QA-05 + SEC-01: require HTTPS and a real TLD — this rejects localhost,
  // plain-http URLs, and raw IP addresses at the DTO validation layer before
  // the service even sees the request. The SSRF IP-range check in WebhookService
  // is the second line of defence for edge cases (e.g. hostnames that resolve to
  // private IPs pass the URL format check but are still blocked at send time).
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

// SEC-01: restricted to admins. Previously any authenticated customer could
// register webhook URLs, meaning a compromised or malicious customer account
// could use the webhook delivery system as an SSRF pivot into the internal
// network (Redis, MongoDB, AWS metadata service, etc.).
@ApiTags('Webhooks')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post()
  @ApiOperation({ summary: '[Admin] Register a webhook endpoint (HTTPS only)' })
  async register(@Request() req: any, @Body() dto: RegisterWebhookDto) {
    return successResponse(await this.webhookService.register(req.user.userId, dto.url, dto.events))
  }

  @Get()
  @ApiOperation({ summary: '[Admin] List registered webhooks (secret redacted)' })
  async list(@Request() req: any) {
    return successResponse(await this.webhookService.list(req.user.userId))
  }

  @Delete(':id')
  @ApiOperation({ summary: '[Admin] Delete a webhook by ID' })
  @ApiParam({ name: 'id' })
  async remove(@Request() req: any, @Param('id') id: string) {
    return successResponse(await this.webhookService.delete(id, req.user.userId))
  }
}
