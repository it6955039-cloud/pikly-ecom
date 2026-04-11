import { Module, forwardRef } from '@nestjs/common'
import { CategoriesService }    from './categories.service'
import { CategoriesController } from './categories.controller'
import { ProductsModule }       from '../products/products.module'

@Module({
  imports:     [forwardRef(() => ProductsModule)],
  providers:   [CategoriesService],
  controllers: [CategoriesController],
  exports:     [CategoriesService],
})
export class CategoriesModule {}