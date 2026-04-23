import { Module }                     from '@nestjs/common'
import { HomepageController }          from './homepage.controller'
import { HomepageService }             from './homepage.service'
import { HomepageWidgetsService }      from './homepage-widgets.service'
import { PersonalizationService }      from './homepage-personalization.service'
import { ProductsModule }              from '../products/products.module'
import { CategoriesModule }            from '../categories/categories.module'

@Module({
  imports:     [ProductsModule, CategoriesModule],
  controllers: [HomepageController],
  providers:   [HomepageService, HomepageWidgetsService, PersonalizationService],
  // Export all three so AdminModule (which imports HomepageModule) can inject them
  exports:     [HomepageService, HomepageWidgetsService, PersonalizationService],
})
export class HomepageModule {}
