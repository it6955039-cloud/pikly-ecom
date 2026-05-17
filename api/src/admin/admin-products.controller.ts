/**
 * @file admin/admin-products.controller.ts
 *
 * Fixes:
 *   BUG-TOGGLE  — toggle() reads current is_active directly from DB
 *                 (products[] only contains active rows — inactive always threw 404)
 *                 toggle() now also returns the new is_active state so the
 *                 frontend does not need an extra GET to know the result.
 *
 *   BUG-DELETE  — adminDelete() hard-deletes from DB
 *                 (previously was soft-delete: SET is_active = false)
 */

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
import { RequireRoleGuard } from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole } from '../identity/guards/identity.guards'
import { ProductsService } from '../products/products.service'
import { AdminCreateProductDto } from '../products/dto/admin-create-product.dto'
import { AdminUpdateProductDto } from '../products/dto/admin-update-product.dto'
import { DatabaseService } from '../database/database.service'
import { successResponse } from '../common/api-utils'

@ApiTags('Admin — Products')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/products')
export class AdminProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly db: DatabaseService,
  ) {}

  // ── List ───────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: '[Admin] List all products with search and pagination' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'isActive',
    required: false,
    description: 'true | false — omit for all (active + inactive)',
  })
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
        // Only filter by isActive when explicitly provided.
        // Omitting = show ALL products (active + inactive).
        isActive: isActive !== undefined ? isActive === 'true' : undefined,
      }),
    )
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({ summary: '[Admin] Create a new product' })
  async create(@Body() body: AdminCreateProductDto) {
    return successResponse(await this.productsService.adminCreate(body))
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Update product fields by ASIN' })
  @ApiParam({ name: 'id', description: 'Product ASIN' })
  async update(@Param('id') id: string, @Body() body: AdminUpdateProductDto) {
    return successResponse(await this.productsService.adminUpdate(id, body))
  }

  // ── Toggle active / inactive ───────────────────────────────────────────────

  @Patch(':id/toggle')
  @ApiOperation({
    summary: '[Admin] Toggle product active / inactive',
    description:
      'Reads current is_active directly from DB (not from the in-memory array which ' +
      'only contains active products). Returns the new is_active state so the ' +
      'frontend can update its UI without an extra GET.',
  })
  @ApiParam({ name: 'id', description: 'Product ASIN' })
  async toggle(@Param('id') id: string) {
    // Read from DB — NOT from this.productsService.products[].
    // The in-memory array is loaded with WHERE is_active=true; any inactive
    // product is absent, so toggling it always threw PRODUCT_NOT_FOUND.
    const row = await this.db.queryOne<{ asin: string; is_active: boolean }>(
      `SELECT asin, is_active FROM store.products WHERE asin = $1`,
      [id],
    )

    if (!row) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: `Product "${id}" not found`,
      })
    }

    const newState = !row.is_active
    await this.productsService.adminUpdate(id, { is_active: newState })

    // Return the new state explicitly — frontend doesn't need an extra GET.
    return successResponse({
      asin: id,
      is_active: newState,
      updated: true,
    })
  }

  // ── Hard Delete ────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Permanently delete a product',
    description: 'Hard-deletes the row from the database. Use toggle to temporarily hide instead.',
  })
  @ApiParam({ name: 'id', description: 'Product ASIN' })
  async remove(@Param('id') id: string) {
    return successResponse(await this.productsService.adminDelete(id))
  }
}
