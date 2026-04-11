// src/users/users.service.ts — PostgreSQL, no Mongoose
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import { UpdateProfileDto, AddAddressDto, UpdateAddressDto } from './dto/users.dto'
import * as crypto from 'crypto'

const POINTS_PER_DOLLAR = 100

function safeUser(row: any) {
  if (!row) return null
  const { password_hash, ..._ } = row
  return {
    id:            row.id,
    email:         row.email,
    firstName:     row.first_name,
    lastName:      row.last_name,
    avatar:        row.avatar,
    phone:         row.phone,
    role:          row.role,
    loyaltyPoints: row.loyalty_points,
    isVerified:    row.is_verified,
    isActive:      row.is_active,
    lastLogin:     row.last_login,
    addresses:     row.addresses ?? [],
    createdAt:     row.created_at,
  }
}

@Injectable()
export class UsersService {
  constructor(private readonly db: DatabaseService) {}

  private async findOrFail(userId: string) {
    const user = await this.db.queryOne('SELECT * FROM store.users WHERE id = $1', [userId])
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' })
    return user
  }

  async getProfile(userId: string) {
    return safeUser(await this.findOrFail(userId))
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.findOrFail(userId)
    const sets: string[] = []
    const vals: any[]    = []
    let   i = 1
    if (dto.firstName !== undefined) { sets.push(`first_name = $${i++}`); vals.push(dto.firstName) }
    if (dto.lastName  !== undefined) { sets.push(`last_name = $${i++}`);  vals.push(dto.lastName) }
    if (dto.phone     !== undefined) { sets.push(`phone = $${i++}`);      vals.push(dto.phone) }
    if (dto.avatar    !== undefined) { sets.push(`avatar = $${i++}`);     vals.push(dto.avatar) }
    if (!sets.length) return safeUser(await this.findOrFail(userId))
    sets.push('updated_at = NOW()')
    vals.push(userId)
    const row = await this.db.queryOne(
      `UPDATE store.users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals,
    )
    return safeUser(row)
  }

  async getAddresses(userId: string) {
    const user = await this.findOrFail(userId) as any
    return user.addresses ?? []
  }

  async addAddress(userId: string, dto: AddAddressDto) {
    const user      = await this.findOrFail(userId) as any
    const addresses = user.addresses ?? []
    const newAddr   = {
      id:        crypto.randomUUID(),
      ...dto,
      isDefault: dto.isDefault ?? addresses.length === 0,
    }
    if (newAddr.isDefault) addresses.forEach((a: any) => { a.isDefault = false })
    addresses.push(newAddr)
    await this.db.execute(
      'UPDATE store.users SET addresses = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(addresses), userId],
    )
    return newAddr
  }

  async updateAddress(userId: string, addressId: string, dto: UpdateAddressDto) {
    const user      = await this.findOrFail(userId) as any
    const addresses = user.addresses ?? []
    const idx       = addresses.findIndex((a: any) => a.id === addressId)
    if (idx === -1) throw new NotFoundException({ code: 'ADDRESS_NOT_FOUND' })
    if (dto.isDefault) addresses.forEach((a: any) => { a.isDefault = false })
    addresses[idx] = { ...addresses[idx], ...dto }
    await this.db.execute(
      'UPDATE store.users SET addresses = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(addresses), userId],
    )
    return addresses[idx]
  }

  async deleteAddress(userId: string, addressId: string) {
    const user      = await this.findOrFail(userId) as any
    const addresses = (user.addresses ?? []).filter((a: any) => a.id !== addressId)
    await this.db.execute(
      'UPDATE store.users SET addresses = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(addresses), userId],
    )
    return { deleted: true }
  }

  async getLoyaltyPoints(userId: string) {
    const user = await this.findOrFail(userId) as any
    return {
      points:   user.loyalty_points ?? 0,
      valueUsd: ((user.loyalty_points ?? 0) / POINTS_PER_DOLLAR).toFixed(2),
    }
  }

  async awardLoyaltyPoints(userId: string, orderTotal: number) {
    const points = Math.floor(orderTotal)
    await this.db.execute(
      'UPDATE store.users SET loyalty_points = loyalty_points + $1 WHERE id = $2',
      [points, userId],
    )
    return points
  }

  // BUG FIX: this method was called from UsersController but was missing entirely,
  // causing a runtime crash on POST /users/loyalty/redeem.
  async redeemLoyaltyPoints(userId: string, pointsToRedeem: number) {
    if (pointsToRedeem < POINTS_PER_DOLLAR) {
      throw new BadRequestException({
        code:    'MIN_REDEMPTION',
        message: `Minimum redemption is ${POINTS_PER_DOLLAR} points ($1.00)`,
      })
    }

    const user = await this.findOrFail(userId) as any
    const currentPoints = user.loyalty_points ?? 0

    if (currentPoints < pointsToRedeem) {
      throw new BadRequestException({
        code:    'INSUFFICIENT_POINTS',
        message: `You have ${currentPoints} points but tried to redeem ${pointsToRedeem}`,
      })
    }

    const creditUsd = parseFloat((pointsToRedeem / POINTS_PER_DOLLAR).toFixed(2))
    await this.db.execute(
      'UPDATE store.users SET loyalty_points = loyalty_points - $1 WHERE id = $2',
      [pointsToRedeem, userId],
    )

    return {
      pointsRedeemed:  pointsToRedeem,
      creditUsd,
      remainingPoints: currentPoints - pointsToRedeem,
    }
  }
}
