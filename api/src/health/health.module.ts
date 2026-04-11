import { Module }            from '@nestjs/common'
import { HealthController }  from './health.controller'
import { ProductsModule }    from '../products/products.module'
import { CategoriesModule }  from '../categories/categories.module'

@Module({
  imports:     [ProductsModule, CategoriesModule],
  controllers: [HealthController],
})
export class HealthModule {}
