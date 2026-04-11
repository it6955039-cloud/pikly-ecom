import { Module } from '@nestjs/common'
import { RecentlyViewedController } from './recently-viewed.controller'
import { RecentlyViewedService } from './recently-viewed.service'
import { ProductsModule } from '../products/products.module'
@Module({ imports:[ProductsModule], controllers:[RecentlyViewedController], providers:[RecentlyViewedService] })
export class RecentlyViewedModule {}
