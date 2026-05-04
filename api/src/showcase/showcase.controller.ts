/**
 * @file showcase/showcase.controller.ts
 *
 * ShowcaseController — interactive demo of the legacy (Dormant Shadow) auth system.
 * Routes: GET /showcase/info, GET /showcase/profile, GET /showcase/admin
 *
 * All routes use ShadowSessionMiddleware (legacy_session cookie / X-Legacy-Session-Token).
 * ZERO interaction with Clerk or the production security context.
 */

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation }      from '@nestjs/swagger'

import { successResponse }    from '../common/api-utils'
import {
  ShowcaseAuthGuard,
  ShowcaseRoleGuard,
  RequireRole,
} from '../identity/guards/identity.guards'
import { ShowcaseUser }       from '../identity/decorators/identity.decorators'
import { ShowcaseSession }    from '../identity/middleware/shadow-session.middleware'

@ApiTags('Showcase / Legacy Auth Demo')
@Controller('showcase')
export class ShowcaseController {

  /** Public — no auth. Shows the dual-adapter architecture info. */
  @Get('info')
  @ApiOperation({ summary: '[Showcase] System info — dual-adapter architecture overview' })
  getInfo() {
    return successResponse({
      architecture: 'Hexagonal (Ports & Adapters)',
      adapters: {
        production: {
          name:       'ClerkProductionAdapter',
          idProvider: 'Clerk (JWKS/RS256)',
          routes:     'All routes except /showcase/*',
          sessionCtx: 'clerk_production',
        },
        showcase: {
          name:       'LegacyShowcaseAdapter',
          idProvider: 'Custom bcrypt + HS256 JWT',
          routes:     '/showcase/* only',
          sessionCtx: 'legacy_showcase',
          note:       'Dormant shadow — fully functional, production-isolated',
        },
      },
      securityIsolation: [
        'Separate middleware per route group',
        'Separate Redis namespaces (legacy:blacklist vs blacklist)',
        'Separate cookie/header names (legacy_session vs Clerk session)',
        'sessionCtx discriminant on every identity object',
      ],
    })
  }

  /** Requires a valid legacy session cookie. */
  @Get('profile')
  @UseGuards(ShowcaseAuthGuard)
  @ApiOperation({ summary: '[Showcase] Profile via legacy JWT — demonstrates dormant auth flow' })
  getProfile(@ShowcaseUser() session: ShowcaseSession) {
    return successResponse({
      message:      'Legacy session resolved successfully',
      legacyUserId: session.legacyUserId,
      email:        session.email,
      role:         session.role,
      sessionCtx:   session.sessionCtx,
      expiresAt:    session.expiresAt,
      note:         'This was verified by LegacyShowcaseAdapter — Clerk had no involvement',
    })
  }

  /** Requires legacy session + admin role. */
  @Get('admin')
  @UseGuards(ShowcaseAuthGuard, ShowcaseRoleGuard)
  @RequireRole('admin')
  @ApiOperation({ summary: '[Showcase] Admin-only — demonstrates legacy RBAC' })
  getAdmin(@ShowcaseUser() session: ShowcaseSession) {
    return successResponse({
      message:    'Admin access via legacy showcase adapter',
      adminId:    session.legacyUserId,
      sessionCtx: session.sessionCtx,
    })
  }
}
