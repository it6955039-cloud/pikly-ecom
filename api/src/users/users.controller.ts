import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  ParseIntPipe,
  Query,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { IsInt, Min } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { UsersService } from './users.service'
import { successResponse } from '../common/api-utils'
import { UpdateProfileDto, AddAddressDto, UpdateAddressDto } from './dto/users.dto'

class RedeemPointsDto {
  @ApiProperty({
    description: 'Number of loyalty points to redeem (minimum 100 = $1.00)',
    example: 500,
  })
  @IsInt()
  @Min(100)
  @Type(() => Number)
  points: number
}

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get my profile' })
  async getProfile(@Request() req: any) {
    return successResponse(await this.usersService.getProfile(req.user.userId))
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update my profile' })
  async updateProfile(@Request() req: any, @Body() dto: UpdateProfileDto) {
    return successResponse(await this.usersService.updateProfile(req.user.userId, dto))
  }

  @Get('addresses')
  @ApiOperation({ summary: 'Get my saved addresses' })
  async getAddresses(@Request() req: any) {
    return successResponse(await this.usersService.getAddresses(req.user.userId))
  }

  @Post('addresses')
  @ApiOperation({ summary: 'Add a new address' })
  async addAddress(@Request() req: any, @Body() dto: AddAddressDto) {
    return successResponse(await this.usersService.addAddress(req.user.userId, dto))
  }

  @Patch('addresses/:addressId')
  @ApiOperation({ summary: 'Update an existing address' })
  async updateAddress(
    @Request() req: any,
    @Param('addressId') addressId: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return successResponse(await this.usersService.updateAddress(req.user.userId, addressId, dto))
  }

  @Delete('addresses/:addressId')
  @ApiOperation({ summary: 'Delete an address' })
  async deleteAddress(@Request() req: any, @Param('addressId') addressId: string) {
    return successResponse(await this.usersService.deleteAddress(req.user.userId, addressId))
  }

  // ── Loyalty Points ─────────────────────────────────────────────────────────

  @Get('loyalty')
  @ApiOperation({ summary: 'Get my loyalty points balance and dollar value' })
  async getLoyaltyPoints(@Request() req: any) {
    return successResponse(await this.usersService.getLoyaltyPoints(req.user.userId))
  }

  @Post('loyalty/redeem')
  @ApiOperation({ summary: 'Redeem loyalty points for store credit (100 points = $1.00)' })
  @ApiBody({ type: RedeemPointsDto })
  async redeemPoints(@Request() req: any, @Body() dto: RedeemPointsDto) {
    return successResponse(await this.usersService.redeemLoyaltyPoints(req.user.userId, dto.points))
  }
}
