import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { HomepageService } from './homepage.service'
import { HomepageWidgetsService } from './homepage-widgets.service'
import { PersonalizationService } from './homepage-personalization.service'
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard'
import { successResponse } from '../common/api-utils'

@ApiTags('Homepage')
@Controller('homepage')
export class HomepageController {
  constructor(
    private readonly homepageService: HomepageService,
    private readonly widgetsService: HomepageWidgetsService,
    private readonly p13nService: PersonalizationService,
  ) {}

  // ── Existing routes (unchanged) ───────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'Get full homepage data (hero, categories, deals, new arrivals, etc.)',
  })
  async getHomepage() {
    const result = await this.homepageService.getHomepage()
    const { cacheHit, ...data } = result
    return successResponse(data, { cacheHit })
  }

  @Get('banners')
  @ApiOperation({
    summary: 'Get banners — filter by position (hero | sidebar | category_top)',
  })
  @ApiQuery({ name: 'position', required: false })
  async getBanners(@Query('position') position?: string) {
    return successResponse(await this.homepageService.getBanners(position))
  }

  // ── New: widget slot composition API ─────────────────────────────────────

  @Get('widgets')
  @UseGuards(OptionalJwtGuard)
  @ApiOperation({
    summary: 'Get resolved homepage widget slots (page composition)',
    description: `
Returns the ordered list of active homepage sections with their fully-resolved
data payloads. This is the dynamic, admin-configurable alternative to GET /homepage.

Widget types returned:
- **hero_banner**      → { banners[] }
- **product_carousel** → { products[], strategy }
- **category_grid**    → { cells[] } — 2×N subcategory image grid
- **dept_spotlight**   → { dept, products[] }
- **campaign**         → { products[], strategy, filterDept }

Authenticated users (Bearer token) also receive widgets with target="authenticated".
Anonymous visitors receive only target="all" and target="anonymous" widgets.
    `,
  })
  @ApiBearerAuth()
  async getWidgets(@Request() req: any) {
    // OptionalJwtGuard populates req.user when a valid JWT is present but
    // does NOT throw for unauthenticated requests — so both paths work.
    const isAuthenticated = !!req.user?.userId
    const widgets = await this.widgetsService.getActiveWidgets(isAuthenticated)
    return successResponse(widgets, { widgetCount: widgets.length })
  }

  // ── New: authenticated personalization API ────────────────────────────────

  @Get('personalized')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get personalised homepage sections (requires authentication)',
    description: `
Returns four personalization sections for the authenticated user:

- **continueShoppingFor**    — Recently viewed items not yet purchased
- **basedOnBrowsingHistory** — Top-rated products from the user's most-visited departments
                               (Wilson-score sorted: rating × log(reviews))
- **alsoViewed**             — Item-item collaborative filtering via SQL co-occurrence.
                               "Customers who viewed items you've viewed also viewed..."
- **moreToConsider**         — Trending products in the user's affinity departments

All sections fall back gracefully to global signals when the user has no history,
so the endpoint always returns useful data even for new accounts.

Results are cached per-user in Redis for 5 minutes.
    `,
  })
  async getPersonalized(@Request() req: any) {
    const data = await this.p13nService.getPersonalized(req.user.userId)
    return successResponse(data, { fromCache: data.meta.fromCache })
  }
}
