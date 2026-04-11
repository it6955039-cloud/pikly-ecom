// src/departments/departments.module.ts

import { Module }             from '@nestjs/common'
import { DepartmentsService }    from './departments.service'
import { DepartmentsController } from './departments.controller'
import { ProductsModule }        from '../products/products.module'

@Module({
  imports:     [ProductsModule],
  providers:   [DepartmentsService],
  controllers: [DepartmentsController],
  exports:     [DepartmentsService],
})
export class DepartmentsModule {}
