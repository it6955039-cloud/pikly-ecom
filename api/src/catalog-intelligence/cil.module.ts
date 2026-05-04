// src/catalog-intelligence/cil.module.ts  ← REPLACE
//
// CHANGES vs original:
//   1. Added IdentityModule — provides RequireRoleGuard + JitProvisioningGuard
//      for CilAdminController.
//   All other providers/exports unchanged.

import { Module }         from '@nestjs/common'
import { ConfigModule }   from '@nestjs/config'
import { IdentityModule } from '../identity/identity.module'

import { NeonService }                 from './services/neon.service'
import { AttributeIntelligenceService } from './services/attribute-intelligence.service'
import { AttributeFamilyService }      from './services/attribute-family.service'
import { DataQualityService }          from './services/data-quality.service'
import { EnrichmentPipelineService }   from './services/enrichment-pipeline.service'
import { CilAdminController }          from './controllers/cil-admin.controller'

@Module({
  imports: [
    ConfigModule,
    IdentityModule,   // ← provides RequireRoleGuard, JitProvisioningGuard, @RequireRole
  ],
  providers: [
    NeonService,
    AttributeIntelligenceService,
    AttributeFamilyService,
    DataQualityService,
    EnrichmentPipelineService,
  ],
  controllers: [CilAdminController],
  exports: [
    NeonService,
    AttributeIntelligenceService,
    AttributeFamilyService,
    DataQualityService,
    EnrichmentPipelineService,
  ],
})
export class CatalogIntelligenceModule {}
