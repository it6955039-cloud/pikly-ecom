// src/catalog-intelligence/services/neon.service.ts
// Uses standard pg (TCP) instead of @neondatabase/serverless (WebSocket).
// @neondatabase/serverless Pool requires neonConfig.webSocketConstructor = ws
// on Node 20 — without it every query hangs silently forever.

import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy, InternalServerErrorException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

@Injectable()
export class NeonService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NeonService.name)
  private pool: Pool | null = null
  private healthy = false

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const dsn =
      this.config.get<string>('NEON_DATABASE_URL') ??
      this.config.get<string>('DATABASE_URL')
    if (!dsn) {
      this.logger.warn('No DSN for CIL — AI features disabled')
      return
    }
    this.pool = new Pool({
      connectionString:        dsn,
      max:                     5,
      idleTimeoutMillis:       20_000,
      connectionTimeoutMillis: 10_000,
      ssl:                     { rejectUnauthorized: false },
    })
    this.pool.on('error', (err: Error) => {
      this.logger.error(`CIL pool error: ${err.message}`)
      this.healthy = false
    })
    let client: PoolClient | null = null
    try {
      client = await this.pool.connect()
      await client.query('SELECT 1')
      this.healthy = true
      this.logger.log('Neon CIL pool connected (pg/TCP)')
    } catch (err) {
      this.logger.warn(
        `CIL pool failed — AI features degraded: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      client?.release()
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => void 0)
  }

  getPool(): Pool {
    if (!this.pool)
      throw new InternalServerErrorException(
        'CIL pool not ready. Set DATABASE_URL or NEON_DATABASE_URL.',
      )
    return this.pool
  }

  isHealthy(): boolean { return this.healthy }

  async query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (!this.pool) { this.logger.warn('CIL query skipped — pool not ready'); return [] }
    try {
      const result: QueryResult<T> = await this.pool.query<T>(sql, params)
      return result.rows ?? []
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`CIL query error: ${msg}`)
      throw new Error(`CIL query failed: ${msg}`)
    }
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect()
    try {
      await client.query('BEGIN')
      const r = await fn(client)
      await client.query('COMMIT')
      return r
    } catch (err) {
      await client.query('ROLLBACK').catch(() => void 0)
      throw err
    } finally {
      client.release()
    }
  }
}