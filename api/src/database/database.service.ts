/**
 * @file database/database.service.ts  ← ADD methods if not already present
 *
 * DatabaseService — thin wrapper around the Neon (pg) pool already used in the project.
 *
 * The GIM and Outbox services call four methods:
 *   queryOne<T>  — returns the first row or null
 *   query<T>     — returns all rows
 *   execute      — runs a mutation, returns rowCount
 *   transaction  — wraps a callback in BEGIN/COMMIT/ROLLBACK
 *
 * If your existing DatabaseService already exposes these signatures, do nothing —
 * this file is a reference implementation showing what GIM/Outbox expect.
 *
 * If your service uses different method names (e.g. findOne / findMany / run),
 * either rename here or add thin aliases. No logic in GIM/Outbox needs to change.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool, PoolClient } from 'pg'

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name)
  private pool!: Pool

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    this.pool = new Pool({
      connectionString: this.config.getOrThrow<string>('DATABASE_URL'),
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: false },
    })
    this.pool.on('error', (err) =>
      this.logger.error(`PG pool error: ${err.message}`),
    )
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end()
  }

  // ── Core query helpers ────────────────────────────────────────────────────

  /** Return all rows. Returns [] on empty result. */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query(sql, params)
    return result.rows as T[]
  }

  /** Return first row, or null if no rows. */
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const result = await this.pool.query(sql, params)
    return (result.rows[0] as T) ?? null
  }

  /**
   * Execute a mutation (INSERT/UPDATE/DELETE without RETURNING).
   * Returns the number of rows affected.
   */
  async execute(sql: string, params: unknown[] = []): Promise<number> {
    const result = await this.pool.query(sql, params)
    return result.rowCount ?? 0
  }

  /**
   * Run a callback inside an atomic BEGIN/COMMIT transaction.
   * The callback receives a PoolClient scoped to the transaction.
   * Automatically ROLLBACK on any thrown error.
   *
   * Usage (called by GIM.upsertMapping):
   *   const result = await db.transaction(async (client) => {
   *     await client.query('INSERT ...')
   *     await client.query('INSERT ...')
   *     return someValue
   *   })
   */
  async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
}
