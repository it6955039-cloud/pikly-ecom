import { Module, forwardRef } from '@nestjs/common'
import { ProductsService }    from './products.service'
import { ProductsController } from './products.controller'
import { CategoriesModule }   from '../categories/categories.module'
import { AlgoliaModule }      from '../algolia/algolia.module'

@Module({
  imports:     [forwardRef(() => CategoriesModule), AlgoliaModule],
  providers:   [ProductsService],
  controllers: [ProductsController],
  exports:     [ProductsService],
})
export class ProductsModule {}
