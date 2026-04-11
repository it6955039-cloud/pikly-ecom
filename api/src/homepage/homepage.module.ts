import { Module }             from '@nestjs/common'
import { HomepageController } from './homepage.controller'
import { HomepageService }    from './homepage.service'
import { ProductsModule }     from '../products/products.module'
import { CategoriesModule }   from '../categories/categories.module'

@Module({
  imports:     [ProductsModule, CategoriesModule],
  controllers: [HomepageController],
  providers:   [HomepageService],
  exports:     [HomepageService],
})
export class HomepageModule {}
