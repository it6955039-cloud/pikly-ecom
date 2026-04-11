import { Module } from '@nestjs/common'
import { CompareController } from './compare.controller'
import { CompareService } from './compare.service'
import { ProductsModule } from '../products/products.module'
@Module({ imports: [ProductsModule], controllers: [CompareController], providers: [CompareService] })
export class CompareModule {}
