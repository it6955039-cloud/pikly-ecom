import { Module } from '@nestjs/common'
import { CategoryShowcaseController } from './category-showcase.controller'
import { CategoryShowcaseService } from './category-showcase.service'
import { ProductsModule } from '../products/products.module'
import { CategoriesModule } from '../categories/categories.module'

@Module({
  imports: [ProductsModule, CategoriesModule],
  controllers: [CategoryShowcaseController],
  providers: [CategoryShowcaseService],
})
export class CategoryShowcaseModule {}
