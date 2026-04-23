// src/homepage/homepage.module.ts
import { Module } from '@nestjs/common'
import { HomepageController } from './homepage.controller'
import { HomepageService } from './homepage.service'
import { HomepageStorefrontService } from './homepage-storefront.service'
import { PersonalizationService } from './homepage-personalization.service'
import { ProductsModule } from '../products/products.module'
import { CategoriesModule } from '../categories/categories.module'

@Module({
  imports: [ProductsModule, CategoriesModule],
  controllers: [HomepageController],
  providers: [HomepageService, HomepageStorefrontService, PersonalizationService],
  exports: [HomepageService, HomepageStorefrontService, PersonalizationService],
})
export class HomepageModule {}
