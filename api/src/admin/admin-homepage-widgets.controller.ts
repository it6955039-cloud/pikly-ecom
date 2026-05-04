// src/admin/admin-homepage-widgets.controller.ts
//
// Admin CRUD + reorder API for homepage widget slots.
//
// All routes require: RequireRoleGuard + JitProvisioningGuard + @RequireRole('admin').
// Follows the exact same guard + decorator pattern as admin-banners.controller.ts.
//
// Routes:
//   GET    /api/admin/homepage-widgets          — list all (including inactive)
//   POST   /api/admin/homepage-widgets          — create
//   PATCH  /api/admin/homepage-widgets/reorder  — atomic bulk reorder
//   GET    /api/admin/homepage-widgets/:id      — single widget
//   PATCH  /api/admin/homepage-widgets/:id      — update
//   PATCH  /api/admin/homepage-widgets/:id/toggle — toggle active
//   DELETE /api/admin/homepage-widgets/:id      — delete

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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiParam } from '@nestjs/swagger'
import { RequireRoleGuard }     from '../identity/guards/identity.guards'
import { JitProvisioningGuard } from '../identity/jit/jit-provisioning.guard'
import { RequireRole }          from '../identity/guards/identity.guards'


import { HomepageWidgetsService } from '../homepage/homepage-widgets.service'
import {
  CreateWidgetDto,
  UpdateWidgetDto,
  ReorderWidgetsDto,
} from '../homepage/dto/homepage-widget.dto'
import { successResponse } from '../common/api-utils'

@ApiTags('Admin — Homepage Widgets')
@ApiBearerAuth()
@UseGuards(RequireRoleGuard, JitProvisioningGuard)
@RequireRole('admin')
@Controller('admin/homepage-widgets')
export class AdminHomepageWidgetsController {
  constructor(private readonly widgetsService: HomepageWidgetsService) {}

  // ── List ──────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: '[Admin] List all homepage widget slots (active + inactive)',
    description:
      'Returns every widget row ordered by position. Use the reorder endpoint to change display order.',
  })
  async findAll() {
    return successResponse(await this.widgetsService.adminFindAll())
  }

  // ── Create ────────────────────────────────────────────────────────────────

  @Post()
  @ApiOperation({
    summary: '[Admin] Create a new homepage widget slot',
    description: `
Widget types and their required config shapes:

**hero_banner**
\`\`\`json
{ "bannerPosition": "hero" }
\`\`\`

**product_carousel**
\`\`\`json
{ "strategy": "featured | bestsellers | trending | new_arrivals | on_sale | top_rated | by_dept",
  "dept": "Electronics",
  "limit": 12 }
\`\`\`

**category_grid**
\`\`\`json
{ "dept": "Home & Kitchen", "subcats": ["Kitchen","Dining"],
  "maxPrice": 50, "limit": 4, "productsPerCell": 2 }
\`\`\`

**dept_spotlight**
\`\`\`json
{ "dept": "Electronics", "limit": 4 }
\`\`\`

**campaign**
\`\`\`json
{ "strategy": "on_sale", "dept": "Beauty", "limit": 8 }
\`\`\`
    `,
  })
  async create(@Body() body: CreateWidgetDto) {
    return successResponse(await this.widgetsService.adminCreate(body))
  }

  // ── Bulk reorder ──────────────────────────────────────────────────────────
  // Must be defined BEFORE :id routes to prevent 'reorder' being matched as id.

  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Atomically reorder widgets',
    description:
      'Pass an ordered array of widget IDs. Each ID is assigned `position = arrayIndex`. ' +
      'IDs not in the list are left unchanged. Runs in a single DB transaction.',
  })
  async reorder(@Body() body: ReorderWidgetsDto) {
    return successResponse(await this.widgetsService.adminReorder(body))
  }

  // ── Single ────────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: '[Admin] Get a single widget by id' })
  @ApiParam({ name: 'id' })
  async findOne(@Param('id') id: string) {
    const all = await this.widgetsService.adminFindAll()
    const widget = all.find((w: any) => w.id === id)
    if (!widget)
      throw new NotFoundException({ code: 'WIDGET_NOT_FOUND', message: `Widget "${id}" not found` })
    return successResponse(widget)
  }

  // ── Update ────────────────────────────────────────────────────────────────

  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Update a widget slot by id' })
  @ApiParam({ name: 'id' })
  async update(@Param('id') id: string, @Body() body: UpdateWidgetDto) {
    return successResponse(await this.widgetsService.adminUpdate(id, body))
  }

  // ── Toggle active ─────────────────────────────────────────────────────────

  @Patch(':id/toggle')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Toggle widget active/inactive',
    description: 'Flips the is_active flag and invalidates homepage caches.',
  })
  @ApiParam({ name: 'id' })
  async toggle(@Param('id') id: string) {
    return successResponse(await this.widgetsService.adminToggle(id))
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Admin] Delete a homepage widget slot permanently',
    description:
      'Hard delete — the widget row is removed. This action is irreversible. ' +
      'Consider toggling is_active = false instead if you may want it back.',
  })
  @ApiParam({ name: 'id' })
  async remove(@Param('id') id: string) {
    return successResponse(await this.widgetsService.adminDelete(id))
  }
}
