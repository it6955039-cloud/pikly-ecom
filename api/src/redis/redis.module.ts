import { Global, Module } from '@nestjs/common'
import { RedisService } from './redis.service'

// @Global() makes RedisService available everywhere without needing to import
// RedisModule in every feature module — it is infrastructure shared by auth,
// orders, products, and the idempotency layer.
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
