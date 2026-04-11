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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { RolesGuard } from '../common/guards/roles.guard'
import { Roles } from '../common/decorators/roles.decorator'
import { ProductsService } from '../products/products.service'
import { AdminCreateProductDto } from '../products/dto/admin-create-product.dto'
import { AdminUpdateProductDto } from '../products/dto/admin-update-product.dto'
import { successResponse } from '../common/api-utils'

@ApiTags('Admin — Products')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({ summary: '[Admin] List all products with search and pagination' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'isActive', required: false })
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('isActive') isActive?: string,
  ) {
    return successResponse(
      await this.productsService.adminFindAll({
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20,
        search,
        isActive: isActive !== undefined ? isActive === 'true' : undefined,
      }),
    )
  }

  @Post()
  @ApiOperation({ summary: '[Admin] Create a new product' })
  async create(@Body() body: AdminCreateProductDto) {
    return successResponse(await this.productsService.adminCreate(body))
  }

  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Update product by id' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() body: AdminUpdateProductDto) {
    return successResponse(await this.productsService.adminUpdate(id, body))
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: '[Admin] Toggle product active/inactive' })
  @ApiParam({ name: 'id' })
  async toggle(@Param('id') id: string) {
    const current =
      this.productsService.findProductByAsin(id) ??
      this.productsService.products.find((p: any) => p.id === id) // include inactive
    if (!current)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: `Product "${id}" not found`,
      })
    return successResponse(
      await this.productsService.adminUpdate(id, { is_active: !(current.is_active ?? current.isActive) }),
    )
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '[Admin] Delete a product permanently' })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    return successResponse(await this.productsService.adminDelete(id))
  }
}