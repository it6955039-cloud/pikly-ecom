/**
 * @file optional-jit.guard.ts
 * @layer Infrastructure / Guards
 *
 * OptionalJitGuard — cart aur aisi endpoints ke liye jo guests aur
 * logged-in users dono ko allow karti hain.
 *
 * JitProvisioningGuard se fark:
 *   JitProvisioningGuard  → req.verifiedToken nahi hai toh THROW karta hai
 *   OptionalJitGuard      → req.verifiedToken nahi hai toh GUEST treat karta hai
 *
 * Flow:
 *   Token present  → user DB mein dhundho → req.identity set karo
 *   Token absent   → kuch mat karo → controller guest samjhega
 */

import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common'
import { ModuleRef, ContextIdFactory } from '@nestjs/core'
import {
  IIdentityService,
  ResolvedIdentity,
  ResolvedIdentitySchema,
} from '../ports/identity.port'
import { IdentityMappingService } from '../gim/identity-mapping.service'

@Injectable()
export class OptionalJitGuard implements CanActivate {
  private readonly logger = new Logger(OptionalJitGuard.name)

  constructor(
    private readonly identityService: IIdentityService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<any>()

    // Token nahi → guest hai, kuch nahi karna, true return karo
    if (!req.verifiedToken) return true

    const { externalId, email, role, jti, expiresAt } = req.verifiedToken

    try {
      const contextId = ContextIdFactory.getByRequest(req)
      this.moduleRef.registerRequestByContextId(req, contextId)

      const gim = await this.moduleRef.resolve(IdentityMappingService, contextId, {
        strict: false,
      })

      let internalId = await gim.resolve(externalId)

      // Agar DB mein nahi mila → JIT provision karo (naya user)
      if (!internalId) {
        this.logger.log(`[OptionalJit] Provisioning new user: ${externalId} (${email})`)

        internalId = await this.identityService.provisionUser({
          externalId,
          email,
          firstName: email.split('@')[0]?.replace(/[._]/g, ' ') ?? 'User',
          lastName: '',
          role: role ?? 'customer',
          source: 'jit_guard',   // ← allowed values: clerk_webhook | jit_guard | legacy_migration
        })
      }

      // req.identity set karo — ab controller logged-in user samjhega
      const identity: ResolvedIdentity = ResolvedIdentitySchema.parse({
        internalId,
        externalId,
        email,
        role: role ?? 'customer',
        sessionCtx: 'clerk_production',
        expiresAt,
        jti,
      })

      req.identity = identity
    } catch (err: unknown) {
      // Optional guard — koi bhi error aaye, guest treat karo (throw mat karo)
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.warn(`[OptionalJit] Identity resolution failed for ${externalId}: ${msg}`)
    }

    return true
  }
}
