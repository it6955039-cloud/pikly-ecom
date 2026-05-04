# Clerk IdP Migration — Complete File Placement Guide
# Covers all 58 TypeScript files + 1 SQL migration + 1 .env template
#
# OPERATION KEY
#   [NEW]     — Does not exist in your project. Create it at this path.
#   [REPLACE] — Exists in your project. Overwrite the file entirely.
#   [KEEP]    — Do not touch. Used as-is by the legacy showcase adapter.
#   [DELETE]  — Remove after Clerk is fully validated in production.
#
# PHASE ORDER
#   Run phases in order. Each phase is independently deployable.
#   The app stays live throughout — zero-downtime migration.

# ═══════════════════════════════════════════════════════════════════════════════
# BEFORE YOU START — install one new dependency
# ═══════════════════════════════════════════════════════════════════════════════
#
#   cd api
#   npm install jose          # RS256 JWKS verification for ClerkProductionAdapter
#   npm install cookie-parser # legacy_session cookie parsing for showcase routes
#   npm install -D @types/cookie-parser

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 0 — Database migration (run before any code deployment)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Additive-only. Zero breaking changes to existing schema.
# Safe to run while the old codebase is live.

[NEW] sql/002_identity_migration.sql
      → Copy to: api/sql/002_identity_migration.sql
      → Run:     psql $DATABASE_URL -f sql/002_identity_migration.sql
      Creates:
        store.identity_mapping  — maps Clerk external IDs to internal UUIDs
        store.identity_outbox   — transactional outbox for at-least-once delivery
      Alters store.users:
        + auth_provider TEXT DEFAULT 'legacy'   (non-breaking — has default)
        + clerk_id TEXT UNIQUE                  (nullable — non-breaking)
        password_hash column → nullable         (Clerk users have no password)
      Includes rollback script as a comment at the bottom.

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 1 — Environment variables
# ═══════════════════════════════════════════════════════════════════════════════

[NEW] .env.clerk-migration
      → Open this file, fill in the three CLERK_* values from your
        Clerk Dashboard, then run:  cat .env.clerk-migration >> api/.env
      Required keys added:
        CLERK_ISSUER_URL       # https://<your-app>.clerk.accounts.dev
        CLERK_SECRET_KEY       # sk_live_...
        CLERK_WEBHOOK_SECRET   # whsec_...
      Optional:
        CLERK_AUDIENCE         # only if you configured JWT audience
        IDENTITY_PROVIDER      # 'clerk' (default) or 'legacy' for rollback

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 2 — Identity Abstraction Layer (NEW directory: src/identity/)
#
# Create the entire src/identity/ tree. None of these files exist yet.
# ═══════════════════════════════════════════════════════════════════════════════

[NEW] src/identity/ports/identity.port.ts
      The Hexagonal Port. Defines IIdentityService (abstract class used as DI
      token), ResolvedIdentity, VerifiedToken, ProvisionPayload Zod schemas,
      and the SHOWCASE_IDENTITY_SERVICE string token.
      Rule: every other file in the codebase imports auth types from HERE only.

[NEW] src/identity/schemas/identity.schemas.ts
      All Zod schemas for external payloads: Clerk JWT claims, Svix webhook
      envelopes, legacy JWT shape, outbox record. No NestJS dependencies.

[NEW] src/identity/adapters/clerk-production.adapter.ts
      Primary production adapter. Verifies Clerk RS256 JWTs via jose JWKS
      client (1-hour key cache). Provisions users via GIM. Revokes sessions
      via Clerk REST API. isProductionAdapter = true.

[NEW] src/identity/adapters/legacy-showcase.adapter.ts
      Dormant shadow adapter. Verifies HS256 JWTs with existing JWT_SECRET.
      Reads/writes ONLY to Redis namespace legacy:blacklist:{jti}.
      isProductionAdapter = false (hardcoded — never change this).

[NEW] src/identity/gim/identity-mapping.service.ts
      Global Identity Mapping. REQUEST scoped (Scope.REQUEST) — each request
      gets its own L1 Map<externalId, internalId> cache. Single DB query for
      cache misses. resolveBatch() fetches N IDs with one SQL ANY($1) call.
      Prevents N+1 queries on list endpoints.

[NEW] src/identity/jit/jit-provisioning.guard.ts
      Just-In-Time Provisioning Guard. Handles the race where a user arrives
      before the Clerk webhook fires. Uses ModuleRef.resolve() + ContextIdFactory
      to safely consume the REQUEST-scoped GIM from a SINGLETON guard.
      Populates req.identity after resolving or provisioning the user.

[NEW] src/identity/outbox/outbox.service.ts
      Writes identity lifecycle events to store.identity_outbox in the same
      DB transaction as user creation. Prevents dual-write split-brain.

[NEW] src/identity/outbox/outbox.processor.ts
      Background poller (5-second interval). SELECT FOR UPDATE SKIP LOCKED
      for multi-replica safety. Exponential backoff (2^n seconds, max 5 tries).
      Add new downstream consumers by registering handlers — no schema change.

[NEW] src/identity/middleware/clerk-auth.middleware.ts
      Production middleware. Extracts Bearer token, verifies via IIdentityService,
      sets req.verifiedToken. Zero DB calls on the hot path (JWKS cached).

[NEW] src/identity/middleware/shadow-session.middleware.ts
      Showcase-only middleware. Reads legacy_session cookie or
      X-Legacy-Session-Token header. Sets req.showcaseSession.
      Hard assertion: throws if req.verifiedToken already exists on the request
      (structural guarantee that both contexts can never coexist).

[NEW] src/identity/guards/identity.guards.ts
      Five guards that replace AuthGuard('jwt') + RolesGuard everywhere:
        RequireAuthGuard      → replaces @UseGuards(AuthGuard('jwt'))
        RequireRoleGuard      → replaces @UseGuards(AuthGuard('jwt'), RolesGuard)
        OptionalIdentityGuard → replaces @UseGuards(OptionalJwtGuard)
        ShowcaseAuthGuard     → new — for /showcase/* routes only
        ShowcaseRoleGuard     → new — RBAC within showcase context

[NEW] src/identity/decorators/identity.decorators.ts
      Parameter decorators replacing @Request() req: any everywhere:
        @CurrentUser()   → ResolvedIdentity (full Clerk identity object)
        @CurrentUserId() → string (internalId UUID — the most common case)
        @OptionalUser()  → ResolvedIdentity | null (cart, wishlist guest paths)
        @ShowcaseUser()  → ShowcaseSession (legacy showcase routes only)

[NEW] src/identity/clerk/clerk-webhook.controller.ts
      Inbound Clerk/Svix webhook receiver at POST /clerk/webhooks.
      Full Svix HMAC-SHA256 signature verification with replay attack protection.
      Handles: user.created → provision, user.updated → sync,
               session.ended → revoke, user.deleted → soft-delete.

[NEW] src/identity/clerk/showcase-auth.controller.ts
      Legacy auth demo at /showcase/auth/*.
      login / register / logout / introspect — all using bcrypt + HS256 JWT.
      Issues tokens into legacy_session cookie (path=/showcase — scoped so
      browsers NEVER send it to production routes).

[NEW] src/identity/identity.module.ts
      Composition root for the entire IAL.
      Wires ClerkProductionAdapter as IIdentityService (production token).
      Wires LegacyShowcaseAdapter as SHOWCASE_IDENTITY_SERVICE (string token).
      configure() enforces middleware routing:
        /showcase/*       → ShadowSessionMiddleware only
        /clerk/webhooks   → no auth middleware (raw body preserved for Svix)
        everything else   → ClerkAuthMiddleware only
      onModuleInit() validates exactly one isProductionAdapter=true adapter exists.

[NEW] src/identity/identity.guards.ts
      Barrel re-export so modules importing from identity.module barrel work.

[NEW] src/identity/tests/identity.spec.ts
      Unit tests: LegacyShowcaseAdapter (namespace isolation, expiry, blacklist),
      IdentityMappingService (L1 cache hits, batch N+1 prevention),
      ClerkAuthMiddleware (optional auth, malformed header), ShadowSessionMiddleware
      (cross-context leak prevention).

[NEW] src/identity/tests/identity-integration.spec.ts
      Integration tests: middleware mutual exclusion proof, GIM batch (1 DB call
      for N IDs), concurrent JIT race safety (10 parallel provisions = 1 UUID),
      outbox idempotency + exponential backoff formula, Redis namespace isolation,
      ShowcaseAuthGuard expiry check.

[NEW] src/showcase/showcase.module.ts
      Wires ShowcaseAuthController + ShowcaseController.
      Imports IdentityModule for guards and the SHOWCASE_IDENTITY_SERVICE token.
      Does NOT export anything to other modules.

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 3 — Infrastructure service updates
# ═══════════════════════════════════════════════════════════════════════════════

[REPLACE] src/database/database.service.ts
          The GIM and Outbox depend on four methods:
            queryOne<T>(sql, params)   → T | null
            query<T>(sql, params)      → T[]
            execute(sql, params)       → rowCount: number
            transaction(fn)            → wraps callback in BEGIN/COMMIT/ROLLBACK
          If your existing DatabaseService already has these exact signatures,
          skip this file — do not overwrite.
          If method names differ, add aliases matching these signatures.

[REPLACE] src/redis/redis.service.ts
          LegacyShowcaseAdapter and ShowcaseAuthController call:
            get(key)                          → string | null
            set(key, value, ttlSeconds?)      → void
            incrementLoginFailure(email)      → number
            getLoginFailures(email)           → number
            clearLoginFailures(email)         → void
          The showcase adapter passes email directly (not a namespaced key).
          The adapter internally prefixes with legacy:blacklist: for blacklist ops.
          If your existing RedisService already matches these signatures, skip.

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 4 — Domain controller migrations (REPLACE existing files)
#
# All business logic is IDENTICAL to your originals.
# Only the auth surface changes: guard imports + parameter decorators.
# ═══════════════════════════════════════════════════════════════════════════════

[REPLACE] src/users/users.controller.ts
          Guards:  AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard
          Params:  @Request() req → @CurrentUserId() userId / @CurrentUser() user

[REPLACE] src/users/users.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/orders/orders.controller.ts
          Guards:  AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard
          Params:  req.user.userId → @CurrentUserId() userId
          Idempotency-Key header forwarding is preserved unchanged.

[REPLACE] src/orders/orders.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/cart/cart.controller.ts
          Guards:  OptionalJwtGuard → OptionalIdentityGuard (class level)
                   AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard (mergeCart only)
          Params:  @Request() req + req.user?.userId → @OptionalUser() user → user?.internalId
          SEC-04 preserved: authenticated session is always derived from verified
          internalId — client-provided sessionId is ignored for auth'd users.

[REPLACE] src/cart/cart.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/wishlist/wishlist.controller.ts
          Guards:  AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard
          Params:  req.user.userId → @CurrentUserId() userId

[REPLACE] src/wishlist/wishlist.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/products/products.controller.ts
          Guards:  submitReview only — AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard
          Params:  req.user.userId → @CurrentUserId() userId (submitReview only)
          All other endpoints are public — no change.

[REPLACE] src/products/products.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/homepage/homepage.controller.ts
          v2-aware. New endpoints: GET /homepage/storefront/v2 (OptionalIdentityGuard)
          and GET /homepage/personalized/v2 (RequireAuthGuard + JIT).
          v1 deprecated endpoints also migrated to IAL guards.
          Uses @OptionalUser() and @CurrentUserId() throughout.

[REPLACE] src/homepage/homepage.module.ts
          Adds HomepageStorefrontV2Service + PersonalizationV2Service (v2 services).
          Adds IdentityModule to imports.

[REPLACE] src/recently-viewed/recently-viewed.controller.ts
          Guards:  AuthGuard('jwt') → RequireAuthGuard + JitProvisioningGuard
          Params:  req.user.userId → @CurrentUserId() userId

[REPLACE] src/recently-viewed/recently-viewed.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/webhooks/webhook.controller.ts
          Guards:  AuthGuard('jwt') + RolesGuard + @Roles('admin')
                → RequireRoleGuard + JitProvisioningGuard + @RequireRole('admin')
          Params:  req.user.userId → @CurrentUserId() userId
          userId is passed to WebhookService.register/list/delete (unchanged signatures).

[REPLACE] src/webhooks/webhook.module.ts
          Change: add IdentityModule to imports array.

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 5 — Admin controller migrations
# ═══════════════════════════════════════════════════════════════════════════════
#
# All 9 admin controllers have the same guard swap:
#   BEFORE: @UseGuards(AuthGuard('jwt'), RolesGuard) + @Roles('admin')
#   AFTER:  @UseGuards(RequireRoleGuard, JitProvisioningGuard) + @RequireRole('admin')
#
# None of these controllers use req.user — no parameter changes needed.

[REPLACE] src/admin/admin-users.controller.ts
          Guard swap. Also adds LEFT JOIN to identity_mapping in list/detail
          queries so admin UI shows each user's Clerk ID alongside their UUID.

[REPLACE] src/admin/admin-orders.controller.ts
          Guard swap. All order management logic (status updates, tracking,
          webhook dispatching, email notifications) is byte-for-byte identical.

[REPLACE] src/admin/admin-analytics.controller.ts
          Guard swap only.

[REPLACE] src/admin/admin-bulk.controller.ts
          Guard swap only.

[REPLACE] src/admin/admin-coupons.controller.ts
          Guard swap only.

[REPLACE] src/admin/admin-banners.controller.ts
          Guard swap only.

[REPLACE] src/admin/admin-categories.controller.ts
          Guard swap only.

[REPLACE] src/admin/admin-products.controller.ts
          Guard swap only.

[NEW] src/admin/admin-homepage-widgets.controller.ts
      New file added in v2. Already migrated with IAL guards.
      Handles widget CRUD for the v2 homepage widget system.

[REPLACE] src/admin/admin.module.ts
          Change: add AdminHomepageWidgetsController (new in v2).
          Change: add IdentityModule to imports array.

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 6 — Health, Uploads, Catalog Intelligence
# ═══════════════════════════════════════════════════════════════════════════════

[REPLACE] src/health/health.controller.ts
          Guards:  AuthGuard('jwt') + RolesGuard + @Roles('admin') (detail endpoint)
                → RequireRoleGuard + JitProvisioningGuard + @RequireRole('admin')
          Public GET /health endpoint is untouched.

[REPLACE] src/health/health.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/uploads/uploads.controller.ts
          Guards:  AuthGuard('jwt') + RolesGuard + @Roles('admin') (class level)
                → RequireRoleGuard + JitProvisioningGuard + @RequireRole('admin')
          Cloudinary upload logic is byte-for-byte identical.

[REPLACE] src/uploads/uploads.module.ts
          Change: add IdentityModule to imports array.

[REPLACE] src/catalog-intelligence/controllers/cil-admin.controller.ts
          Guards:  AuthGuard('jwt') + RolesGuard + @Roles('admin')
                → RequireRoleGuard + JitProvisioningGuard + @RequireRole('admin')
          Note: the delivery file is at src/catalog-intelligence/cil-admin.controller.ts
          (flat) — move it to src/catalog-intelligence/controllers/ when placing.

[REPLACE] src/catalog-intelligence/cil.module.ts
          Change: add IdentityModule to imports array.

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 7 — Bootstrap files
# ═══════════════════════════════════════════════════════════════════════════════

[REPLACE] src/app.module.ts
          Remove: AuthModule import (no longer needed — Clerk handles production auth)
          Add:    IdentityModule (replaces AuthModule)
          Add:    ShowcaseModule (legacy demo at /showcase/*)
          All other module imports: completely unchanged.

[REPLACE] src/main.ts
          Add: rawBody: true to NestFactory.create() options
               THIS IS MANDATORY. Without it, req.rawBody is undefined and every
               Svix webhook signature check fails with a 400 error.
          Add: cookie-parser middleware (for legacy_session showcase cookie)
          Add: CLERK_ISSUER_URL + CLERK_WEBHOOK_SECRET to required env check
          Add: X-Legacy-Session-Token + Svix webhook headers to CORS allowedHeaders
          Update: Swagger config adds BearerAuth + CookieAuth docs

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 8 — Clerk Dashboard configuration
# ═══════════════════════════════════════════════════════════════════════════════
#
# 1. Create application at https://dashboard.clerk.com
#
# 2. JWT Template — add this to customise the token claims:
#    Session token → Edit → add:
#    {
#      "public_metadata": "{{user.public_metadata}}"
#    }
#    This makes the user's role appear as claims.public_metadata.role in the JWT.
#
# 3. Webhooks → Add endpoint:
#    URL:    https://your-api-domain.com/api/clerk/webhooks
#    Events: user.created, user.updated, session.ended, user.deleted
#    Copy the Signing Secret → set as CLERK_WEBHOOK_SECRET in your .env
#
# 4. Verify the webhook is receiving events:
#    After deploying, check store.identity_outbox — you should see
#    user.provisioned rows appearing for each new sign-up.

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE 9 — Cleanup (AFTER full production validation, not before)
# ═══════════════════════════════════════════════════════════════════════════════
#
# Only delete/remove after:
#   1. All users are signing in via Clerk
#   2. JIT provisioning logs show no new hits (webhooks arriving on time)
#   3. store.identity_outbox shows no failed events (attempts >= 5)
#   4. Showcase demo has been signed off by stakeholders
#   5. All integration tests pass against production

[DELETE] src/auth/jwt.strategy.ts
         Passport JWT strategy — replaced by ClerkAuthMiddleware + jose.
         Delete only after PassportModule is fully removed from AuthModule.

# --- DO NOT delete these — the legacy showcase adapter still uses them ---

[KEEP] src/auth/auth.service.ts
[KEEP] src/auth/auth.controller.ts
[KEEP] src/auth/auth.module.ts
[KEEP] src/auth/dto/auth.dto.ts
       These power the dormant legacy auth demo (bcrypt login, token refresh).
       They are only reachable via /showcase/auth/* routes.
       Optionally rename AuthModule to LegacyAuthModule for clarity.

[KEEP] src/common/guards/optional-jwt.guard.ts
[KEEP] src/common/guards/roles.guard.ts
[KEEP] src/common/decorators/roles.decorator.ts
       Unused by production code after migration. Keep initially as dead code
       so any missed call site causes a compile error rather than a runtime
       mystery. Delete once you have confirmed zero imports remain.

# ═══════════════════════════════════════════════════════════════════════════════
# QUICK REFERENCE — guard replacement map
# ═══════════════════════════════════════════════════════════════════════════════
#
#   BEFORE                                          AFTER
#   ─────────────────────────────────────────────────────────────────────────────
#   @UseGuards(AuthGuard('jwt'))                    @UseGuards(RequireAuthGuard, JitProvisioningGuard)
#   @UseGuards(AuthGuard('jwt'), RolesGuard)        @UseGuards(RequireRoleGuard, JitProvisioningGuard)
#   @Roles('admin')                                 @RequireRole('admin')
#   @UseGuards(OptionalJwtGuard)                    @UseGuards(OptionalIdentityGuard)
#   @Request() req: any → req.user.userId           @CurrentUserId() userId: string
#   @Request() req: any → req.user                  @CurrentUser() user: ResolvedIdentity
#   @Request() req: any → req.user?.userId          @OptionalUser() user: ResolvedIdentity | null
#                                                    → user?.internalId
#
# ═══════════════════════════════════════════════════════════════════════════════
# QUICK REFERENCE — import paths
# ═══════════════════════════════════════════════════════════════════════════════
#
# Guards (in any controller):
#   import { RequireAuthGuard, RequireRoleGuard, OptionalIdentityGuard, RequireRole }
#     from '../identity/guards/identity.guards'
#   import { JitProvisioningGuard }
#     from '../identity/jit/jit-provisioning.guard'
#
# Decorators (in any controller):
#   import { CurrentUser, CurrentUserId, OptionalUser }
#     from '../identity/decorators/identity.decorators'
#
# Type (in any file that needs the identity shape):
#   import { ResolvedIdentity }
#     from '../identity/ports/identity.port'
#
# In modules (to make guards available to controllers):
#   import { IdentityModule } from '../identity/identity.module'
#   // then add IdentityModule to the @Module({ imports: [...] }) array
#
# ═══════════════════════════════════════════════════════════════════════════════
# CUTOVER CHECKLIST
# ═══════════════════════════════════════════════════════════════════════════════
#
#  [ ] 1. psql $DATABASE_URL -f sql/002_identity_migration.sql
#  [ ] 2. Set CLERK_ISSUER_URL, CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET in Railway
#  [ ] 3. Set IDENTITY_PROVIDER=clerk in Railway
#  [ ] 4. Deploy — app boots with IdentityModule live alongside legacy
#  [ ] 5. Configure Clerk webhook → https://your-api/api/clerk/webhooks
#  [ ] 6. Verify webhook: grep "ClerkWebhook" in Railway logs → user.created events
#  [ ] 7. Verify JIT: grep "[JIT] Provisioning" — hits expected in first 24h only
#  [ ] 8. Monitor outbox: SELECT * FROM store.identity_outbox WHERE attempts >= 3
#  [ ] 9. Verify showcase: POST /api/showcase/auth/login → get legacy_session cookie
#  [ ] 10. Sign off showcase demo with stakeholders
#  [ ] 11. Phase 9 cleanup (delete legacy guards, jwt.strategy.ts)
#
# Emergency rollback (any time before step 11):
#   Set IDENTITY_PROVIDER=legacy in Railway → redeploy → done.
#   No code changes, no DB changes required.
