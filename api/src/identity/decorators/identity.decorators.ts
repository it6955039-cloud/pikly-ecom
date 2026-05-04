/**
 * @file identity.decorators.ts
 * @layer Infrastructure / Decorators
 *
 * Parameter decorators for injecting the resolved identity into controller
 * method parameters. These replace the legacy `@Request() req: any` + `req.user`
 * pattern throughout all controllers.
 *
 * Migration:
 *   BEFORE:  async getProfile(@Request() req: any) {
 *              return this.usersService.getProfile(req.user.userId)
 *            }
 *
 *   AFTER:   async getProfile(@CurrentUser() user: ResolvedIdentity) {
 *              return this.usersService.getProfile(user.internalId)
 *            }
 *
 *   SHOWCASE BEFORE:  async showcaseProfile(@Request() req: any) {
 *                       return this.legacyService.getProfile(req.user.userId)
 *                     }
 *
 *   SHOWCASE AFTER:   async showcaseProfile(@ShowcaseUser() session: ShowcaseSession) {
 *                       return this.legacyService.getProfile(session.legacyUserId)
 *                     }
 *
 * These decorators are pure syntactic sugar over createParamDecorator.
 * They add no logic — the middleware and guards are responsible for populating
 * the request objects they read from.
 */

import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common'
import { Request } from 'express'
import { ResolvedIdentity } from '../ports/identity.port'
import { ShowcaseSession } from '../middleware/shadow-session.middleware'

/**
 * Injects the fully resolved Clerk production identity.
 * Throws if req.identity is absent (guard not applied or JIT not run).
 *
 * @example
 *   async myHandler(@CurrentUser() user: ResolvedIdentity) {
 *     // user.internalId — UUID for DB queries
 *     // user.externalId — Clerk ID for Clerk API calls
 *     // user.role       — 'customer' | 'admin'
 *   }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedIdentity => {
    const req = ctx.switchToHttp().getRequest<Request>()

    if (!req.identity) {
      throw new UnauthorizedException({
        code:    'IDENTITY_NOT_RESOLVED',
        message: 'req.identity is null. Ensure JitProvisioningGuard is applied.',
      })
    }

    return req.identity
  },
)

/**
 * Injects only the internal UUID — the most common use case.
 * Equivalent to @CurrentUser() + .internalId but more ergonomic.
 *
 * @example
 *   async getProfile(@CurrentUserId() userId: string) {
 *     return this.usersService.getProfile(userId)
 *   }
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<Request>()

    if (!req.identity) {
      throw new UnauthorizedException({ code: 'IDENTITY_NOT_RESOLVED' })
    }

    return req.identity.internalId
  },
)

/**
 * Injects the showcase session — ONLY valid on /showcase/* routes.
 * Will throw if req.showcaseSession is absent (ShowcaseAuthGuard not applied).
 *
 * @example
 *   async showcaseProfile(@ShowcaseUser() session: ShowcaseSession) {
 *     return this.legacyService.getProfile(session.legacyUserId)
 *   }
 */
export const ShowcaseUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ShowcaseSession => {
    const req = ctx.switchToHttp().getRequest<Request>()

    if (!req.showcaseSession) {
      throw new UnauthorizedException({
        code:    'SHOWCASE_SESSION_NOT_RESOLVED',
        message: 'req.showcaseSession is null. Ensure ShowcaseAuthGuard is applied.',
      })
    }

    return req.showcaseSession
  },
)

/**
 * Injects req.identity if present, null if not (optional auth endpoints).
 * Use on routes guarded by OptionalIdentityGuard.
 *
 * @example
 *   async getCart(@OptionalUser() user: ResolvedIdentity | null) {
 *     if (user) return this.cartService.getUserCart(user.internalId)
 *     return this.cartService.getGuestCart(guestId)
 *   }
 */
export const OptionalUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ResolvedIdentity | null => {
    const req = ctx.switchToHttp().getRequest<Request>()
    return req.identity ?? null
  },
)
