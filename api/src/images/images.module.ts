import { Module } from '@nestjs/common'
import { ImagesController } from './images.controller'
import { ImagesService } from './images.service'
import { ProductsModule } from '../products/products.module'

@Module({
  imports: [ProductsModule],
  controllers: [ImagesController],
  providers: [ImagesService],
})
export class ImagesModule {}
