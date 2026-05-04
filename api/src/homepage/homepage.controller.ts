// src/homepage/homepage.controller.ts  ← REPLACE
//
// MIGRATION DIFF vs v2 original:
//   GET /homepage/storefront/v2:
//     OptionalJwtGuard → OptionalIdentityGuard
//     @Request() req   → @OptionalUser() user: ResolvedIdentity | null
//     req?.user?.userId → user?.internalId
//
//   GET /homepage/personalized/v2:
//     AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard
//     @Request() req   → @CurrentUserId() userId: string
//
//   GET /homepage/personalized (deprecated v1):
//     AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard
//
//   All other endpoints: public, no auth, untouched.

import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery, ApiBearerAuth, ApiResponse } from '@nestjs/swagger'

import { HomepageService }             from './homepage.service'
import { HomepageStorefrontService }   from './homepage-storefront.service'
import { HomepageStorefrontV2Service } from './homepage-storefront-v2.service'
import { PersonalizationService }      from './homepage-personalization.service'
import { PersonalizationV2Service }    from './homepage-personalization-v2.service'
import { successResponse }             from '../common/api-utils'

import { OptionalIdentityGuard, RequireAuthGuard } from '../identity/guards/identity.guards'
import { JitProvisioningGuard }  from '../identity/jit/jit-provisioning.guard'
import { OptionalUser, CurrentUserId } from '../identity/decorators/identity.decorators'
import { ResolvedIdentity }      from '../identity/ports/identity.port'

@ApiTags('Homepage')
@Controller('homepage')
export class HomepageController {
  constructor(
    private readonly homepageService: HomepageService,
    private readonly storefrontV1:    HomepageStorefrontService,
    private readonly storefrontV2:    HomepageStorefrontV2Service,
    private readonly p13nV1:          PersonalizationService,
    private readonly p13nV2:          PersonalizationV2Service,
  ) {}

  @Get('storefront/v2')
  @UseGuards(OptionalIdentityGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Storefront v2 — unified layout + in-band personalization' })
  @ApiQuery({ name: 'alsoViewedPage', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Storefront v2 payload' })
  async getStorefrontV2(
    @OptionalUser() user: ResolvedIdentity | null,
    @Query('alsoViewedPage') rawPage?: string,
  ) {
    const userId         = user?.internalId ?? null
    const alsoViewedPage = Math.max(1, parseInt(rawPage ?? '1', 10) || 1)

    const [{ response, cacheHit, cacheTier }, personalization] = await Promise.all([
      this.storefrontV2.getStorefrontV2({ userId, personalization: null, alsoViewedPage }),
      userId ? this.p13nV2.getPersonalized(userId) : Promise.resolve(null),
    ])

    if (personalization) {
      const { response: enriched } = await this.storefrontV2.getStorefrontV2({
        userId, personalization, alsoViewedPage,
      })
      return successResponse(enriched, {
        cacheHit, cacheTier,
        sectionCount: enriched.sections.length,
        productCount: enriched.meta.productCount,
        personalized: true,
      })
    }

    return successResponse(response, {
      cacheHit, cacheTier,
      sectionCount: response.sections.length,
      productCount: response.meta.productCount,
      personalized: false,
    })
  }

  @Get('personalized/v2')
  @UseGuards(RequireAuthGuard, JitProvisioningGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Standalone personalization bundle v2 (requires auth)' })
  async getPersonalizedV2(@CurrentUserId() userId: string) {
    const data = await this.p13nV2.getPersonalized(userId)
    return successResponse(data, { fromCache: data.fromCache })
  }

  // ── Deprecated v1 endpoints ───────────────────────────────────────────────

  @Get('storefront')
  @ApiOperation({ summary: '[Deprecated] v1 storefront', deprecated: true })
  async getStorefront() {
    const { payload, cacheHit, cacheTier } = await this.storefrontV1.getStorefront()
    return successResponse(payload, {
      cacheHit, cacheTier,
      sectionCount: payload.sectionCount,
      _deprecation: { message: 'Migrate to GET /homepage/storefront/v2', retireBy: '2025-09-01' },
    })
  }

  @Get('personalized')
  @UseGuards(RequireAuthGuard, JitProvisioningGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '[Deprecated] v1 personalization', deprecated: true })
  async getPersonalized(@CurrentUserId() userId: string) {
    const data = await this.p13nV1.getPersonalized(userId)
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
  @ApiOperation({ summary: 'Banners slice — filter by position' })
  @ApiQuery({ name: 'position', required: false, example: 'hero' })
  async getBanners(@Query('position') position?: string) {
    return successResponse(await this.homepageService.getBanners(position))
  }
}
