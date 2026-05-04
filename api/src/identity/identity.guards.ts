/**
 * @file identity.guards.ts — full re-export barrel
 * This file exists to satisfy the import in identity.module.ts
 * which uses named re-exports. The actual implementations are in
 * src/identity/guards/identity.guards.ts
 */
export {
  JitProvisioningGuard,
  RequireAuthGuard,
  RequireRoleGuard,
  OptionalIdentityGuard,
  ShowcaseAuthGuard,
  ShowcaseRoleGuard,
  RequireRole,
  REQUIRED_ROLES_KEY,
} from './guards/identity.guards'
