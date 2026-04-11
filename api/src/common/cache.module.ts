import { Global, Module } from '@nestjs/common'
import { CacheService } from './cache.service'

// @Global makes CacheService available everywhere as a single shared instance.
// No module needs to import CacheModule or declare CacheService in providers —
// it just injects CacheService directly. This means when ProductsService calls
// cache.flush(), it clears the same cache that HomepageService and
// CategoriesService read from, so stale data never survives an admin update.
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
