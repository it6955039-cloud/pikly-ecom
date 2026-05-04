/**
 * @file users/users.controller.ts
 * @layer Application / Controller
 *
 * UsersController — AFTER Clerk migration
 *
 * Migration diff summary (compared to original users.controller.ts):
 *
 *   REMOVED:
 *     @UseGuards(AuthGuard('jwt'))        → @UseGuards(RequireAuthGuard, JitProvisioningGuard)
 *     @Request() req: any                 → @CurrentUser() / @CurrentUserId()
 *     req.user.userId                     → user.internalId  (typed, not any)
 *
 *   The controller now has ZERO knowledge of authentication internals.
 *   It receives a strongly-typed ResolvedIdentity and passes internalId
 *   to the service layer. The service layer is unchanged — it still takes
 *   a userId: string and queries store.users by UUID.
 *
 * N+1 prevention note:
 *   UsersService receives internalId directly — no GIM lookup needed inside
 *   the service. The GIM resolution happened once in JitProvisioningGuard.
 *   The L1 cache in IdentityMappingService (REQUEST scoped) ensures any
 *   additional GIM calls within the same request are free.
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger'
import { IsInt, Min } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'

import { UsersService }           from './users.service'
import { successResponse }        from '../common/api-utils'
import { UpdateProfileDto, AddAddressDto, UpdateAddressDto } from './dto/users.dto'

// ✅ New imports replacing AuthGuard('jwt') + @Request() req
import {
  RequireAuthGuard,
  JitProvisioningGuard,
  ResolvedIdentity,
} from '../identity/identity.module'
import {
  CurrentUser,
  CurrentUserId,
} from '../identity/decorators/identity.decorators'

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

/**
 * Controller-level guard application:
 *
 * BEFORE:  @UseGuards(AuthGuard('jwt'))
 * AFTER:   @UseGuards(RequireAuthGuard, JitProvisioningGuard)
 *
 * RequireAuthGuard:     Ensures req.verifiedToken exists (Clerk JWT was valid)
 * JitProvisioningGuard: Resolves externalId→internalId, provisioning if needed,
 *                       then populates req.identity
 *
 * Guards run in order — RequireAuthGuard gates access before JIT does DB work.
 */
@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, JitProvisioningGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ── Profile ─────────────────────────────────────────────────────────────

  @Get('profile')
  @ApiOperation({ summary: 'Get my profile' })
  async getProfile(
    // BEFORE: @Request() req: any → req.user.userId
    // AFTER:  @CurrentUserId() directly injects the UUID — type-safe, no casting
    @CurrentUserId() userId: string,
  ) {
    return successResponse(await this.usersService.getProfile(userId))
  }

  @Patch('profile')
  @ApiOperation({ summary: 'Update my profile' })
  async updateProfile(
    @CurrentUserId() userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return successResponse(await this.usersService.updateProfile(userId, dto))
  }

  // ── Addresses ────────────────────────────────────────────────────────────

  @Get('addresses')
  @ApiOperation({ summary: 'Get my saved addresses' })
  async getAddresses(@CurrentUserId() userId: string) {
    return successResponse(await this.usersService.getAddresses(userId))
  }

  @Post('addresses')
  @ApiOperation({ summary: 'Add a new address' })
  async addAddress(
    @CurrentUserId() userId: string,
    @Body() dto: AddAddressDto,
  ) {
    return successResponse(await this.usersService.addAddress(userId, dto))
  }

  @Patch('addresses/:addressId')
  @ApiOperation({ summary: 'Update an existing address' })
  async updateAddress(
    @CurrentUserId() userId: string,
    @Param('addressId') addressId: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return successResponse(
      await this.usersService.updateAddress(userId, addressId, dto),
    )
  }

  @Delete('addresses/:addressId')
  @ApiOperation({ summary: 'Delete an address' })
  async deleteAddress(
    @CurrentUserId() userId: string,
    @Param('addressId') addressId: string,
  ) {
    return successResponse(await this.usersService.deleteAddress(userId, addressId))
  }

  // ── Loyalty Points ────────────────────────────────────────────────────────

  @Get('loyalty')
  @ApiOperation({ summary: 'Get my loyalty points balance and dollar value' })
  async getLoyaltyPoints(@CurrentUserId() userId: string) {
    return successResponse(await this.usersService.getLoyaltyPoints(userId))
  }

  @Post('loyalty/redeem')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Redeem loyalty points for store credit' })
  @ApiBody({ type: RedeemPointsDto })
  async redeemPoints(
    @CurrentUserId() userId: string,
    @Body() dto: RedeemPointsDto,
  ) {
    return successResponse(
      await this.usersService.redeemLoyaltyPoints(userId, dto.points),
    )
  }

  // ── Example: using full identity object when you need more than just ID ──

  /**
   * Example of using @CurrentUser() for access to the full identity context.
   * Use this when you need role, email, or externalId alongside the internalId.
   */
  @Get('identity-info')
  @ApiOperation({
    summary: 'Returns current identity context (for debugging / showcase comparison)',
  })
  async getIdentityInfo(@CurrentUser() user: ResolvedIdentity) {
    return successResponse({
      internalId:  user.internalId,
      externalId:  user.externalId,
      email:       user.email,
      role:        user.role,
      sessionCtx:  user.sessionCtx,
      expiresAt:   user.expiresAt,
    })
  }
}
