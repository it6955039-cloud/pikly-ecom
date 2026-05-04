/**
 * @file products.module.ts  ← REPLACE src/products/products.module.ts
 */
import { Module, forwardRef } from '@nestjs/common'
import { ProductsService }    from './products.service'
import { ProductsController } from './products.controller'
import { CategoriesModule }   from '../categories/categories.module'
import { AlgoliaModule }      from '../algolia/algolia.module'
import { IdentityModule }     from '../identity/identity.module'

@Module({
  imports:     [forwardRef(() => CategoriesModule), AlgoliaModule, IdentityModule],
  providers:   [ProductsService],
  controllers: [ProductsController],
  exports:     [ProductsService],
})
export class ProductsModule {}
