/**
 * @file identity/identity.guards.ts — barrel re-export
 *
 * Exports all identity-related guards and decorators from a single location.
 * identity.module.ts imports from here so consuming modules only need:
 *   import { IdentityModule } from '../identity/identity.module'
 */

// Guards from guards/identity.guards.ts
export {
  RequireAuthGuard,
  RequireRoleGuard,
  OptionalIdentityGuard,
  ShowcaseAuthGuard,
  ShowcaseRoleGuard,
  RequireRole,
  REQUIRED_ROLES_KEY,
} from './guards/identity.guards'

// JitProvisioningGuard lives in its own file (jit/ subfolder)
export { JitProvisioningGuard, SkipJit, SKIP_JIT_KEY } from './jit/jit-provisioning.guard'
