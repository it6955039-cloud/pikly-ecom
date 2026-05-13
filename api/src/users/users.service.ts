/**
 * @file users/users.service.ts
 * @layer Application / Service
 *
 * Security fix (v3 → v4):
 *   findOrFail() previously only checked whether a user row existed (id match).
 *   It did NOT check is_active, so a deactivated user whose Clerk JWT was still
 *   valid (or whose identity_mapping was not yet synced) could:
 *     1. Pass the JIT guard (if identity_mapping.is_active was still true)
 *     2. Reach the controller with a valid internalId
 *     3. Receive their profile, addresses, loyalty points, etc. — as if active
 *
 *   Fix: findOrFail() now throws ForbiddenException(ACCOUNT_DEACTIVATED) when
 *   is_active = false. This is a defence-in-depth layer — even if the JIT guard
 *   or identity_mapping sync has an edge-case gap, the service layer always
 *   enforces the account state from the authoritative store.users record.
 *
 *   IMPORTANT: ForbiddenException (403) is used, NOT NotFoundException (404).
 *   The user exists — they are just not permitted to act. Returning 404 would
 *   mislead clients into thinking the account was deleted.
 */

import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common'
import { DatabaseService }   from '../database/database.service'
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

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fetch a user row by internal UUID and assert two invariants:
   *   1. The row exists           → NotFoundException (404) if not
   *   2. The account is active    → ForbiddenException (403) if deactivated
   *
   * All service methods that act on behalf of the currently-authenticated user
   * MUST go through findOrFail(). Direct db.queryOne calls in this service are
   * only permitted for admin-initiated mutations that explicitly handle
   * deactivated users (there are none currently — all mutations call findOrFail).
   *
   * Defence-in-depth rationale:
   *   The JIT guard blocks deactivated users at the guard layer by checking
   *   identity_mapping.is_active. This service-layer check ensures that even
   *   in edge cases where the guard passes (e.g., a brief sync lag between
   *   store.users and store.identity_mapping), deactivated users cannot read
   *   or mutate their data.
   */
  private async findOrFail(userId: string): Promise<any> {
    const user = await this.db.queryOne(
      'SELECT * FROM store.users WHERE id = $1',
      [userId],
    )

    if (!user) {
      throw new NotFoundException({
        code:    'USER_NOT_FOUND',
        message: 'User not found',
      })
    }

    // ── Deactivation gate ───────────────────────────────────────────────────
    // is_active = false means an admin has explicitly deactivated this account.
    // We throw 403 (not 404) so the client knows the account exists but is
    // suspended — relevant for user-facing error messages ("contact support").
    if (!(user as any).is_active) {
      throw new ForbiddenException({
        code:    'ACCOUNT_DEACTIVATED',
        message: 'This account has been deactivated. Please contact support.',
      })
    }

    return user
  }

  // ── Profile ────────────────────────────────────────────────────────────────

  async getProfile(userId: string) {
    return safeUser(await this.findOrFail(userId))
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    await this.findOrFail(userId) // asserts active

    const sets: string[] = []
    const vals: any[]    = []
    let   i = 1

    if (dto.firstName !== undefined) { sets.push(`first_name = $${i++}`); vals.push(dto.firstName) }
    if (dto.lastName  !== undefined) { sets.push(`last_name = $${i++}`);  vals.push(dto.lastName)  }
    if (dto.phone     !== undefined) { sets.push(`phone = $${i++}`);      vals.push(dto.phone)     }
    if (dto.avatar    !== undefined) { sets.push(`avatar = $${i++}`);     vals.push(dto.avatar)    }

    if (!sets.length) return safeUser(await this.findOrFail(userId))

    sets.push('updated_at = NOW()')
    vals.push(userId)

    const row = await this.db.queryOne(
      `UPDATE store.users SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals,
    )
    return safeUser(row)
  }

  // ── Addresses ──────────────────────────────────────────────────────────────

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

  // ── Loyalty Points ─────────────────────────────────────────────────────────

  async getLoyaltyPoints(userId: string) {
    const user = await this.findOrFail(userId) as any
    return {
      points:   user.loyalty_points ?? 0,
      valueUsd: ((user.loyalty_points ?? 0) / POINTS_PER_DOLLAR).toFixed(2),
    }
  }

  async awardLoyaltyPoints(userId: string, orderTotal: number) {
    // awardLoyaltyPoints is called by the orders service after delivery —
    // we intentionally do NOT check is_active here. An order placed while
    // the account was active should still credit points even if the account
    // was subsequently deactivated before the order was delivered.
    const points = Math.floor(orderTotal)
    await this.db.execute(
      'UPDATE store.users SET loyalty_points = loyalty_points + $1 WHERE id = $2',
      [points, userId],
    )
    return points
  }

  async redeemLoyaltyPoints(userId: string, pointsToRedeem: number) {
    if (pointsToRedeem < POINTS_PER_DOLLAR) {
      throw new BadRequestException({
        code:    'MIN_REDEMPTION',
        message: `Minimum redemption is ${POINTS_PER_DOLLAR} points ($1.00)`,
      })
    }

    const user          = await this.findOrFail(userId) as any
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
