/**
 * @file identity.guards.ts
 * @layer Infrastructure / Guards
 *
 * Production RBAC guards that replace the legacy AuthGuard('jwt') + RolesGuard.
 *
 * Migration map (existing → new):
 *
 *   @UseGuards(AuthGuard('jwt'))
 *     → @UseGuards(RequireAuthGuard)
 *
 *   @UseGuards(AuthGuard('jwt'), RolesGuard) + @Roles('admin')
 *     → @UseGuards(RequireRoleGuard) + @RequireRole('admin')
 *
 *   OptionalJwtGuard
 *     → @UseGuards(OptionalIdentityGuard)
 *
 *   Showcase routes (currently unguarded or using legacy jwt):
 *     → @UseGuards(ShowcaseAuthGuard)
 *
 * All guards read from req.identity (Clerk production) or req.showcaseSession
 * (legacy showcase) — never from req.user (removed Passport artifact).
 *
 * SOLID:
 *   S — each guard has one job
 *   O — new role checks extend RequireRoleGuard via metadata, not subclassing
 *   D — guards depend on ResolvedIdentity shape (port), not on any adapter
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request } from 'express'

// ── Metadata keys ─────────────────────────────────────────────────────────────

export const REQUIRED_ROLES_KEY = 'requiredRoles'

/** Decorator: marks the role(s) required to access a handler */
export const RequireRole = (...roles: Array<'customer' | 'admin'>) =>
  SetMetadata(REQUIRED_ROLES_KEY, roles)

// ── Guard 1: RequireAuthGuard ─────────────────────────────────────────────────

/**
 * Requires a fully resolved Clerk identity on the request.
 * Replaces: @UseGuards(AuthGuard('jwt'))
 *
 * Must be used AFTER JitProvisioningGuard in the pipeline — JIT populates
 * req.identity. If used without JIT, it can still check req.verifiedToken
 * as a fallback for lightweight checks.
 */
@Injectable()
export class RequireAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>()

    if (!req.identity && !req.verifiedToken) {
      throw new UnauthorizedException({
        code:    'AUTHENTICATION_REQUIRED',
        message: 'You must be signed in to access this resource',
      })
    }

    return true
  }
}

// ── Guard 2: RequireRoleGuard ─────────────────────────────────────────────────

/**
 * Requires a specific role in addition to authentication.
 * Replaces: @UseGuards(AuthGuard('jwt'), RolesGuard) + @Roles('admin')
 *
 * Usage:
 *   @UseGuards(RequireRoleGuard)
 *   @RequireRole('admin')
 *   async adminEndpoint() { ... }
 */
@Injectable()
export class RequireRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Array<'customer' | 'admin'>>(
      REQUIRED_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )

    // No @RequireRole decorator → treat as auth-required but role-agnostic
    if (!requiredRoles || requiredRoles.length === 0) {
      const req = context.switchToHttp().getRequest<Request>()
      if (!req.identity) {
        throw new UnauthorizedException({ code: 'AUTHENTICATION_REQUIRED' })
      }
      return true
    }

    const req  = context.switchToHttp().getRequest<Request>()
    const role = req.identity?.role ?? req.verifiedToken?.role

    if (!role) {
      throw new UnauthorizedException({
        code:    'AUTHENTICATION_REQUIRED',
        message: 'This endpoint requires authentication',
      })
    }

    if (!requiredRoles.includes(role)) {
      throw new ForbiddenException({
        code:    'INSUFFICIENT_ROLE',
        message: `This endpoint requires one of: [${requiredRoles.join(', ')}]`,
      })
    }

    return true
  }
}

// ── Guard 3: OptionalIdentityGuard ───────────────────────────────────────────

/**
 * Allows both authenticated and unauthenticated requests.
 * Populates nothing extra — controllers check req.identity for presence.
 * Replaces: OptionalJwtGuard
 *
 * Usage on cart, product pages, etc. where guests are valid users.
 */
@Injectable()
export class OptionalIdentityGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    // Always passes — middleware already populated req.identity if a valid
    // token was present. Controllers read req.identity and branch accordingly.
    return true
  }
}

// ── Guard 4: ShowcaseAuthGuard ────────────────────────────────────────────────

/**
 * Requires a valid legacy showcase session on /showcase/* routes.
 * Reads from req.showcaseSession — never from req.identity.
 *
 * This guard ensures that even if someone sends a Clerk Bearer token to a
 * showcase route, it is silently ignored (ShadowSessionMiddleware never
 * populates req.showcaseSession from Clerk tokens).
 */
@Injectable()
export class ShowcaseAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>()

    if (!req.showcaseSession) {
      throw new UnauthorizedException({
        code:    'SHOWCASE_SESSION_REQUIRED',
        message: 'A valid legacy session is required for showcase routes. ' +
                 'Use the /showcase/auth/login endpoint to obtain a legacy token.',
      })
    }

    // Extra protection: ensure this session hasn't expired
    const expiresAt = new Date(req.showcaseSession.expiresAt)
    if (expiresAt < new Date()) {
      throw new UnauthorizedException({
        code:    'SHOWCASE_SESSION_EXPIRED',
        message: 'Your legacy showcase session has expired.',
      })
    }

    return true
  }
}

// ── Guard 5: ShowcaseRoleGuard ────────────────────────────────────────────────

/**
 * Role check within the showcase context.
 * Reads exclusively from req.showcaseSession — never bleeds into production.
 */
@Injectable()
export class ShowcaseRoleGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Array<'customer' | 'admin'>>(
      REQUIRED_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )

    if (!requiredRoles || requiredRoles.length === 0) return true

    const req = context.switchToHttp().getRequest<Request>()

    if (!req.showcaseSession) {
      throw new UnauthorizedException({ code: 'SHOWCASE_SESSION_REQUIRED' })
    }

    if (!requiredRoles.includes(req.showcaseSession.role)) {
      throw new ForbiddenException({
        code:    'SHOWCASE_INSUFFICIENT_ROLE',
        message: `Showcase route requires: [${requiredRoles.join(', ')}]`,
      })
    }

    return true
  }
}
