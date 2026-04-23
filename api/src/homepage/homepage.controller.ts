// src/homepage/homepage.controller.ts
import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth } from '@nestjs/swagger'
import { AuthGuard }          from '@nestjs/passport'
import { HomepageService }    from './homepage.service'
import { HomepageStorefrontService } from './homepage-storefront.service'
import { PersonalizationService }    from './homepage-personalization.service'
import { OptionalJwtGuard }   from '../common/guards/optional-jwt.guard'
import { successResponse }    from '../common/api-utils'

@ApiTags('Homepage')
@Controller('homepage')
export class HomepageController {
  constructor(
    private readonly homepageService:    HomepageService,
    private readonly storefrontService:  HomepageStorefrontService,
    private readonly p13nService:        PersonalizationService,
  ) {}

  // ── Primary: Amazon-style storefront ─────────────────────────────────────
  //
  // This is the main endpoint the frontend should use.
  // Returns a fully-typed, ordered array of sections — each section tells the
  // frontend exactly which component to render and supplies all required data.
  //
  // No auth required — works for anonymous visitors.
  // Pair with GET /homepage/personalized for logged-in enhancements.

  @Get('storefront')
  @ApiOperation({
    summary: 'Amazon-style storefront — ordered sections with fully resolved data',
    description: `
Primary homepage endpoint. Returns an ordered \`sections[]\` array.

Each section has a stable \`sectionId\`, a \`type\` that maps to a frontend
component, and a fully resolved \`data\` payload — no secondary API calls needed.

**Section types:**
| type | Frontend component | Data shape |
|---|---|---|
| \`hero_banner\` | HeroBanner / Slider | \`{ banners[] }\` |
| \`category_grid\` | CategoryGrid (2×N) | \`{ cells[] }\` — each cell has name, image, productImages[] |
| \`product_carousel\` | ProductCarousel | \`{ strategy, products[] }\` |
| \`dept_spotlight\` | DeptSpotlight | \`{ dept, products[4] }\` |

**Caching:** L1 NodeCache (5 min) + L2 Redis/Upstash (5 min).
\`meta.cacheHit\` and \`meta.cacheTier\` tell you which tier served the response.

Pair with \`GET /homepage/personalized\` (requires auth) to add personalised
sections for logged-in users.
    `,
  })
  async getStorefront() {
    const { payload, cacheHit, cacheTier } = await this.storefrontService.getStorefront()
    return successResponse(payload, {
      cacheHit,
      cacheTier,
      sectionCount: payload.sectionCount,
    })
  }

  // ── Legacy: flat homepage data (keep for backward compatibility) ──────────

  @Get()
  @ApiOperation({
    summary: '[Legacy] Flat homepage data — prefer GET /homepage/storefront',
  })
  async getHomepage() {
    const result = await this.homepageService.getHomepage()
    const { cacheHit, ...data } = result
    return successResponse(data, { cacheHit })
  }

  @Get('banners')
  @ApiOperation({
    summary: 'Banners — filter by position (hero | secondary | sidebar)',
  })
  @ApiQuery({ name: 'position', required: false })
  async getBanners(@Query('position') position?: string) {
    return successResponse(await this.homepageService.getBanners(position))
  }

  // ── Authenticated personalisation ─────────────────────────────────────────
  //
  // Call this in addition to /storefront when the user is logged in.
  // Inject the returned sections at the appropriate positions in the storefront
  // layout (after hero, after bestsellers, etc.) based on your UX design.

  @Get('personalized')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Personalised sections for logged-in users (requires auth)',
    description: `
Returns four personalisation sections for the authenticated user:

- **continueShoppingFor**    — Recently viewed items not yet purchased
- **basedOnBrowsingHistory** — Top-rated products from the user's most-visited departments
- **alsoViewed**             — Item-item collaborative filtering (SQL co-occurrence)
- **moreToConsider**         — Trending products in user's affinity departments

Falls back gracefully to global signals for new users with no history.
Results cached per-user in Redis for 5 minutes.

**Usage:** Call alongside \`GET /homepage/storefront\` and splice personalised
sections into the layout wherever your UX requires.
    `,
  })
  async getPersonalized(@Request() req: any) {
    const data = await this.p13nService.getPersonalized(req.user.userId)
    return successResponse(data, { fromCache: data.meta.fromCache })
  }
}
