import { Injectable, ExecutionContext } from '@nestjs/common'
import { AuthGuard } from '@nestjs/passport'

// OptionalJwtGuard validates and decodes a JWT if the Authorization header is
// present, populating req.user with the decoded payload. If no token is present
// it does NOT throw — req.user remains null. This is the correct primitive for
// endpoints that serve both authenticated and guest users (e.g. cart).
//
// IMPORTANT: Do NOT use this guard for endpoints that must always be
// authenticated. Use AuthGuard('jwt') for those — it throws 401 on missing tokens.
@Injectable()
export class OptionalJwtGuard extends AuthGuard('jwt') {
  // canActivate delegates to the parent, which runs the JWT strategy.
  // If the strategy throws (token missing or invalid), we catch it and
  // continue rather than propagating the error — that's what makes it optional.
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context)
    } catch {
      // No valid token — continue with req.user = null
    }
    return true
  }

  // handleRequest is called after strategy validation. Normally AuthGuard
  // throws if user is null. We override to return null instead of throwing,
  // which lets the controller check req.user itself.
  handleRequest(_err: any, user: any): any {
    return user ?? null
  }
}
