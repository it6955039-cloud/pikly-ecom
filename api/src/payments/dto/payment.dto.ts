// src/payments/dto/payment.dto.ts
import { IsString, IsNotEmpty, MaxLength } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'

export class CreateCheckoutSessionDto {
  @ApiProperty({
    description: 'The order ID to pay for. Must be in pending status with payment_method=card.',
    example: 'ORD-000042',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  orderId: string
}
