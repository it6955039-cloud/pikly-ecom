// src/homepage/homepage.controller.ts
//
// Routing:
//   GET /homepage/storefront/v2     ← PRIMARY — use this in all new frontend code
//   GET /homepage/personalized/v2   ← supplementary standalone personalization
//   GET /homepage/storefront        ← v1 deprecated (returns deprecation header)
//   GET /homepage/personalized      ← v1 deprecated
//   GET /homepage                   ← legacy flat
//   GET /homepage/banners           ← banner slice
//
// FIX-6: Removed unused @Optional import.
// FIX-7: Removed DefaultValuePipe/ParseIntPipe from import — using manual parse instead
//         to avoid import sprawl. Added simple integer guard directly in handler.

import { Controller, Get, Query, UseGuards, Request } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiResponse } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { HomepageService } from './homepage.service'
import { HomepageStorefrontService } from './homepage-storefront.service'
import { HomepageStorefrontV2Service } from './homepage-storefront-v2.service'
import { PersonalizationService } from './homepage-personalization.service'
import { PersonalizationV2Service } from './homepage-personalization-v2.service'
import { OptionalJwtGuard } from '../common/guards/optional-jwt.guard'
import { successResponse } from '../common/api-utils'

@ApiTags('Homepage')
@Controller('homepage')
export class HomepageController {
  constructor(
    private readonly homepageService: HomepageService,
    private readonly storefrontV1: HomepageStorefrontService,
    private readonly storefrontV2: HomepageStorefrontV2Service,
    private readonly p13nV1: PersonalizationService,
    private readonly p13nV2: PersonalizationV2Service,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /homepage/storefront/v2   ← PRIMARY ENDPOINT
  //
  // For anonymous users:
  //   Full layout with personalized slots as empty placeholders.
  //   Frontend renders skeleton/sign-in CTA in those slots.
  //
  // For authenticated users (Bearer token present):
  //   Full layout with personalized sections populated in-band.
  //   Single request. Zero waterfalls.
  //
  // Pagination:
  //   ?alsoViewedPage=2 paginates the also_viewed_grid section.
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('storefront/v2')
  @UseGuards(OptionalJwtGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Storefront v2 — Amazon-grade unified layout + personalization',
    description: `
**Single-request homepage API.** Returns a fully composed, ordered \`sections[]\`
array that maps 1:1 to frontend components. Zero secondary calls required.

**Auth:**
- No token → anonymous response; personalized slots are empty placeholders
- \`Authorization: Bearer <token>\` → personalized sections populated in-band

**Pagination:**
- \`?alsoViewedPage=N\` paginates the \`also_viewed_grid\` section

**Cache:** Anonymous responses served from L1 NodeCache (5 min) + L2 Redis (5 min).
\`meta.cacheHit\` and \`meta.cacheTier\` indicate which tier served the response.
    `,
  })
  @ApiQuery({
    name: 'alsoViewedPage',
    required: false,
    type: Number,
    description: 'Page number for also_viewed_grid section (default: 1)',
    example: 1,
  })
  @ApiResponse({ status: 200, description: 'Storefront v2 payload' })
  async getStorefrontV2(@Request() req: any, @Query('alsoViewedPage') rawPage?: string) {
    const userId = (req?.user?.userId as string | undefined) ?? null
    const alsoViewedPage = Math.max(1, parseInt(rawPage ?? '1', 10) || 1)

    // Resolve base layout and personalization in parallel.
    // Base layout is nearly always cache-hot (<1ms L1 hit) so there's
    // no real waterfall here — both promises resolve almost simultaneously.
    const [{ response, cacheHit, cacheTier }, personalization] = await Promise.all([
      this.storefrontV2.getStorefrontV2({ userId, personalization: null, alsoViewedPage }),
      userId ? this.p13nV2.getPersonalized(userId) : Promise.resolve(null),
    ])

    // If we have personalization, do a second (near-instant) pass to inject it.
    // The base is from cache; injectPersonalization() is pure in-memory — ~1ms.
    if (personalization) {
      const { response: enriched } = await this.storefrontV2.getStorefrontV2({
        userId,
        personalization,
        alsoViewedPage,
      })
      return successResponse(enriched, {
        cacheHit,
        cacheTier,
        sectionCount: enriched.sections.length,
        productCount: enriched.meta.productCount,
        personalized: true,
      })
    }

    return successResponse(response, {
      cacheHit,
      cacheTier,
      sectionCount: response.sections.length,
      productCount: response.meta.productCount,
      personalized: false,
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // GET /homepage/personalized/v2
  //
  // Standalone personalization bundle for SPA hydration after login,
  // or after a purchase/wishlist-add event that should refresh recommendations.
  //
  // In normal page renders, personalization is already embedded in the v2
  // storefront response — this endpoint is supplementary.
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('personalized/v2')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Standalone personalization bundle v2 (requires auth)',
    description: `
Returns the four personalized section data payloads as \`ProductCardV2[]\`.

**When to call this:**
- SPA hydration after login
- After a purchase to refresh "Continue shopping" / "Also viewed"
- After adding to wishlist to refresh "More to consider"

In normal page renders, use \`GET /homepage/storefront/v2\` with a Bearer token —
personalization is embedded automatically in the sections array.
    `,
  })
  async getPersonalizedV2(@Request() req: any) {
    const data = await this.p13nV2.getPersonalized(req.user.userId)
    return successResponse(data, { fromCache: data.fromCache })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Legacy / deprecated endpoints — kept for backward compat
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('storefront')
  @ApiOperation({
    summary: '[Deprecated] v1 storefront — migrate to GET /homepage/storefront/v2',
    deprecated: true,
  })
  async getStorefront() {
    const { payload, cacheHit, cacheTier } = await this.storefrontV1.getStorefront()
    return successResponse(payload, {
      cacheHit,
      cacheTier,
      sectionCount: payload.sectionCount,
      _deprecation: {
        message: 'Migrate to GET /homepage/storefront/v2',
        retireBy: '2025-09-01',
        docsUrl: '/docs#/Homepage/getStorefrontV2',
      },
    })
  }

  @Get('personalized')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: '[Deprecated] v1 personalization — migrate to GET /homepage/personalized/v2',
    deprecated: true,
  })
  async getPersonalized(@Request() req: any) {
    const data = await this.p13nV1.getPersonalized(req.user.userId)
    return successResponse(data, { fromCache: data.meta?.fromCache ?? false })
  }

  @Get()
  @ApiOperation({ summary: '[Legacy] Flat homepage data', deprecated: true })
  async getHomepage() {
    const result = await this.homepageService.getHomepage()
    const { cacheHit, ...data } = result
    return successResponse(data, { cacheHit })
  }

  @Get('banners')
  @ApiOperation({ summary: 'Banners slice — filter by position (hero | secondary | sidebar)' })
  @ApiQuery({ name: 'position', required: false, example: 'hero' })
  async getBanners(@Query('position') position?: string) {
    return successResponse(await this.homepageService.getBanners(position))
  }
}
