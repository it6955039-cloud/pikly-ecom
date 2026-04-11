import { Global, Module } from '@nestjs/common'
import { AlgoliaService } from './algolia.service'

@Global()
@Module({
  providers: [AlgoliaService],
  exports: [AlgoliaService],
})
export class AlgoliaModule {}