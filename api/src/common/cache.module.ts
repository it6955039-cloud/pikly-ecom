// src/common/cache.module.ts
// CacheService now depends on RedisService for L2 — RedisModule is @Global
// so no explicit import needed here.

import { Global, Module } from '@nestjs/common'
import { CacheService }   from './cache.service'

@Global()
@Module({
  providers: [CacheService],
  exports:   [CacheService],
})
export class CacheModule {}
