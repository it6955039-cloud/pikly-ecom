// src/catalog-intelligence/cil.module.ts
// =============================================================================
// Catalog Intelligence Layer — NestJS Module
//
// Add to AppModule:
//   import { CatalogIntelligenceModule } from './catalog-intelligence/cil.module'
//   @Module({ imports: [..., CatalogIntelligenceModule] })
//
// Required env vars:
//   NEON_DATABASE_URL  — Neon pooler DSN (port 6543, sslmode=require)
//   GEMINI_API_KEY     — from aistudio.google.com/app/apikey (free tier ok)
// =============================================================================

import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { NeonService }                from './services/neon.service'
import { AttributeIntelligenceService } from './services/attribute-intelligence.service'
import { AttributeFamilyService }     from './services/attribute-family.service'
import { DataQualityService }         from './services/data-quality.service'
import { EnrichmentPipelineService }  from './services/enrichment-pipeline.service'
import { CilAdminController }         from './controllers/cil-admin.controller'

@Module({
  imports: [ConfigModule],
  providers: [
    NeonService,
    AttributeIntelligenceService,
    AttributeFamilyService,
    DataQualityService,
    EnrichmentPipelineService,
  ],
  controllers: [CilAdminController],
  exports: [
    // Export so ProductsModule, AlgoliaModule can use accordion/quality data
    NeonService,
    AttributeIntelligenceService,
    AttributeFamilyService,
    DataQualityService,
    EnrichmentPipelineService,
  ],
})
export class CatalogIntelligenceModule {}
