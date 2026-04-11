import { PartialType } from '@nestjs/swagger'
import { AdminCreateProductDto } from './admin-create-product.dto'

// For updates we allow any subset of the create fields.
export class AdminUpdateProductDto extends PartialType(AdminCreateProductDto) {}
