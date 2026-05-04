// src/health/health.module.ts  ← REPLACE
// Change: add IdentityModule so RequireRoleGuard + JitProvisioningGuard resolve.
import { Module }           from '@nestjs/common'
import { HealthController } from './health.controller'
import { ProductsModule }   from '../products/products.module'
import { CategoriesModule } from '../categories/categories.module'
import { IdentityModule }   from '../identity/identity.module'

@Module({
  imports:     [ProductsModule, CategoriesModule, IdentityModule],
  controllers: [HealthController],
})
export class HealthModule {}
