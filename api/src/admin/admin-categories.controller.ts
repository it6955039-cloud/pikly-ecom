import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery, ApiProperty } from '@nestjs/swagger'
import {
  IsString, IsOptional, IsBoolean, IsInt, IsArray,
  MinLength, MaxLength, Min, IsNumber,
} from 'class-validator'
import { Type } from 'class-transformer'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { CategoriesService } from '../categories/categories.service'
import { successResponse } from '../common/api-utils'

// ── DTOs ─────────────────────────────────────────────────────────────────────

class CreateCategoryDto {
  @ApiProperty({ minLength: 1, maxLength: 120 })
  @IsString() @MinLength(1) @MaxLength(120)
  name: string

  @ApiProperty({ description: 'URL-safe slug (auto-derived from name if omitted)', required: false })
  @IsOptional() @IsString() @MaxLength(120)
  slug?: string

  @ApiProperty({ required: false, description: 'Parent category id for nested categories' })
  @IsOptional() @IsString()
  parentId?: string

  @ApiProperty({ required: false, minimum: 0, default: 0 })
  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  level?: number

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500)
  description?: string

  @ApiProperty({ required: false, minimum: 0, default: 0 })
  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  sortOrder?: number
}

class UpdateCategoryDto {
  @ApiProperty({ required: false, minLength: 1, maxLength: 120 })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  name?: string

  @ApiProperty({ required: false, maxLength: 500 })
  @IsOptional() @IsString() @MaxLength(500)
  description?: string

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  is_featured?: boolean

  @ApiProperty({ required: false })
  @IsOptional() @IsBoolean()
  is_active?: boolean

  @ApiProperty({ required: false, minimum: 0 })
  @IsOptional() @IsInt() @Min(0) @Type(() => Number)
  sort_order?: number

  @ApiProperty({ required: false, description: 'Category image URL' })
  @IsOptional() @IsString() @MaxLength(500)
  image?: string

  @ApiProperty({ required: false, description: 'Facet configuration array' })
  @IsOptional() @IsArray()
  facets?: any[]
}

@ApiTags('Admin — Categories')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('admin/categories')
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] List all categories (flat, includes inactive)' })
  @ApiQuery({ name: 'isActive', required: false })
  findAll(@Query('isActive') isActive?: string) {
    let cats = this.categoriesService.categories
    if (isActive !== undefined) cats = cats.filter((c: any) => c.isActive === (isActive === 'true'))
    return successResponse(cats)
  }

  @Post()
  @ApiOperation({ summary: '[Admin] Create a new category' })
  async create(@Body() body: CreateCategoryDto) {
    return successResponse(await this.categoriesService.adminCreate(body))
  }

  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Update category by id' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() body: UpdateCategoryDto) {
    return successResponse(await this.categoriesService.adminUpdate(id, body))
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: '[Admin] Toggle category active/inactive' })
  @ApiParam({ name: 'id' })
  async toggle(@Param('id') id: string) {
    const current = this.categoriesService.categories.find((c: any) => c.id === id)
    if (!current)
      throw new NotFoundException({
        code: 'CATEGORY_NOT_FOUND',
        message: `Category "${id}" not found`,
      })
    return successResponse(
      await this.categoriesService.adminUpdate(id, { isActive: !current.isActive }),
    )
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Delete a category permanently' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    return successResponse(await this.categoriesService.adminDelete(id))
  }
}
