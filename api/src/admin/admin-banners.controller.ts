import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiProperty } from '@nestjs/swagger'
import {
  IsString, IsOptional, IsBoolean, IsInt, IsDateString,
  MaxLength, MinLength, IsIn, IsUrl, Min,
} from 'class-validator'
import { Type } from 'class-transformer'
import { RequireRoleGuard }     from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole }          from '../identity/guards/identity.guards'


import { HomepageService } from '../homepage/homepage.service'
import { successResponse } from '../common/api-utils'

// ── DTOs ─────────────────────────────────────────────────────────────────────

class CreateBannerDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString() @MinLength(1) @MaxLength(120)
  title: string

  @ApiProperty({ required: false, maxLength: 240 })
  @IsOptional() @IsString() @MaxLength(240)
  subtitle?: string

  @ApiProperty({ required: false, description: 'Absolute URL to banner image' })
  @IsOptional() @IsUrl({}, { message: 'image must be a valid URL' })
  image?: string

  @ApiProperty({ required: false, maxLength: 80 })
  @IsOptional() @IsString() @MaxLength(80)
  ctaText?: string

  @ApiProperty({ required: false, maxLength: 500, description: 'CTA link URL or relative path' })
  @IsOptional() @IsString() @MaxLength(500)
  ctaLink?: string

  @ApiProperty({ required: false, enum: ['hero','secondary','sidebar'], default: 'hero' })
  @IsOptional() @IsIn(['hero', 'secondary', 'sidebar'])
  position?: 'hero' | 'secondary' | 'sidebar'

  @ApiProperty({ required: false, description: 'ISO 8601 start date' })
  @IsOptional() @IsDateString()
  startDate?: string

  @ApiProperty({ required: false, description: 'ISO 8601 end date' })
  @IsOptional() @IsDateString()
  endDate?: string

  @ApiProperty({ required: false, default: true })
  @IsOptional() @IsBoolean()
  isActive?: boolean

  @ApiProperty({ required: false, minimum: 0, description: 'Display order (lower = first)' })
  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  sortOrder?: number
}

class UpdateBannerDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 120 })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  title?: string

  @ApiProperty({ required: false, maxLength: 240 })
  @IsOptional() @IsString() @MaxLength(240)
  subtitle?: string

  @ApiProperty({ required: false })
  @IsOptional() @IsUrl({}, { message: 'image must be a valid URL' })
  image?: string

  @ApiProperty({ required: false, maxLength: 80 })
  @IsOptional() @IsString() @MaxLength(80)
  ctaText?: string

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500)
  ctaLink?: string

  @ApiProperty({ required: false, enum: ['hero','secondary','sidebar'] })
  @IsOptional() @IsIn(['hero', 'secondary', 'sidebar'])
  position?: 'hero' | 'secondary' | 'sidebar'

  @ApiProperty({ required: false })
  @IsOptional() @IsDateString()
  startDate?: string

  @ApiProperty({ required: false })
  @IsOptional() @IsDateString()
  endDate?: string

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  isActive?: boolean

  @ApiProperty({ required: false, minimum: 0 })
  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  sortOrder?: number
}

@ApiTags('Admin — Banners')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/banners')
export class AdminBannersController {
  constructor(private readonly homepageService: HomepageService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] List all banners (including inactive and expired)' })
  async findAll() {
    return successResponse(await this.homepageService.adminGetBanners())
  }

  @Post()
  @ApiOperation({ summary: '[Admin] Create a new banner' })
  async create(@Body() body: CreateBannerDto) {
    return successResponse(
      await this.homepageService.adminCreateBanner({
        id:        `ban_${Date.now()}`,
        title:     body.title,
        subtitle:  body.subtitle   ?? '',
        image:     body.image      ?? null,
        ctaText:   body.ctaText    ?? '',
        ctaLink:   body.ctaLink    ?? '',
        position:  body.position   ?? 'hero',
        startDate: body.startDate  ?? new Date().toISOString(),
        endDate:   body.endDate    ?? new Date(Date.now() + 365 * 86_400_000).toISOString(),
        isActive:  body.isActive   ?? true,
        sortOrder: body.sortOrder  ?? 99,
      }),
    )
  }

  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Update a banner by id' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() body: UpdateBannerDto) {
    return successResponse(await this.homepageService.adminUpdateBanner(id, body))
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: '[Admin] Toggle banner active/inactive' })
  @ApiParam({ name: 'id' })
  async toggle(@Param('id') id: string) {
    const banners = await this.homepageService.adminGetBanners()
    const banner = (banners as any[]).find((b: any) => b.id === id)
    if (!banner)
      throw new NotFoundException({ code: 'BANNER_NOT_FOUND', message: `Banner "${id}" not found` })
    return successResponse(
      await this.homepageService.adminUpdateBanner(id, { isActive: !banner.is_active }),
    )
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Delete a banner permanently' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    return successResponse(await this.homepageService.adminDeleteBanner(id))
  }
}
