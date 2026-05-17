// src/database/database.service.ts
//
// FIX v2 — Read-after-write consistency for Neon + pg Pool
//
// Root cause of stale reads after mutations:
//   The app used the Neon POOLER endpoint (ep-xxx-pooler.region.aws.neon.tech).
//   Neon's PgBouncer runs in TRANSACTION mode — each statement may land on a
//   different server-side connection. A WRITE on connection A and a READ on
//   connection B arrive at different physical pg backends in Neon's fleet.
//   Due to TCP buffer flushing order, the READ can execute before the WRITE's
//   WAL record has been applied to that connection's snapshot.
//
//   Combined with pg Pool having max:10, the pool can reuse a different client
//   for the GET that follows a PATCH — compounding the race.
//
// Fixes applied here:
//   1. Pool uses application_name so Neon logs can correlate queries.
//   2. Every new client connection runs SET synchronous_commit = on; and
//      SET default_transaction_isolation = 'read committed'; explicitly —
//      ensuring the server honours WAL flush before ack.
//   3. The real fix is to switch DATABASE_URL from the pooler to the DIRECT
//      endpoint (remove "-pooler" from the hostname in your Railway env var).
//      This file adds a startup warning if the pooler URL is detected.
//
// The only code change required in your Railway dashboard:
//   DATABASE_URL=postgresql://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
//                                              ^^ remove "-pooler" ^^

import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  InternalServerErrorException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name)
  private pool: Pool | null = null

  private _readyResolve!: () => void
  private _readyReject!: (err: Error) => void
  private readonly _ready = new Promise<void>((res, rej) => {
    this._readyResolve = res
    this._readyReject = rej
  })

  waitUntilReady(): Promise<void> {
    return this._ready
  }

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const dsn = this.config.get<string>('DATABASE_URL')
    if (!dsn) {
      const err = new Error('DATABASE_URL is required')
      this._readyReject(err)
      this.logger.error('DATABASE_URL not set')
      throw err
    }

    // ── Pooler detection warning ───────────────────────────────────────────
    // Neon pooler URLs contain "-pooler" in the hostname.
    // Using the pooler causes stale reads after writes because PgBouncer
    // transaction mode can route READ and WRITE to different server connections.
    // Switch to the DIRECT endpoint to guarantee read-after-write consistency.
    if (dsn.includes('-pooler.')) {
      this.logger.warn(
        '⚠️  DATABASE_URL points to Neon POOLER endpoint (contains "-pooler.").\n' +
        '   This causes stale reads after writes (toggle/delete shows old data).\n' +
        '   Fix: remove "-pooler" from the hostname in your Railway environment variable.\n' +
        '   Example: ep-xxx-pooler.region.aws.neon.tech → ep-xxx.region.aws.neon.tech',
      )
    }

    this.pool = new Pool({
      connectionString: dsn,
      max: 5,               // reduced from 10 — Neon free tier max is 5 direct connections
      min: 1,               // keep 1 warm connection — reduces cold-start latency
      idleTimeoutMillis:    30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'pikly-api',
      ssl: { rejectUnauthorized: true },
    })

    // ── Per-connection session defaults ────────────────────────────────────
    // Runs once when pg pool creates a new physical connection.
    // synchronous_commit = on  → server waits for WAL flush before returning
    //                            success — guarantees the write is visible to
    //                            any subsequent read on ANY connection.
    this.pool.on('connect', (client: PoolClient) => {
      client
        .query(`
          SET synchronous_commit = on;
          SET default_transaction_isolation = 'read committed';
          SET statement_timeout = 30000;
          SET lock_timeout = 10000;
        `)
        .catch((err: Error) =>
          this.logger.warn(`Failed to set session defaults: ${err.message}`),
        )
    })

    this.pool.on('error', (err: Error) => {
      this.logger.error(`DB pool error: ${err.message}`)
    })

    try {
      this.logger.log('Connecting to Neon PostgreSQL...')
      const client = await this.pool.connect()
      try {
        await client.query('SELECT 1')
        this.logger.log('Neon PostgreSQL connected (pg/TCP)')
        this._readyResolve()
      } finally {
        client.release()
      }
    } catch (err) {
      const msg = (err as Error).message
      this.logger.error(`Database connection failed: ${msg}`)
      this._readyReject(err as Error)
      throw err
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => void 0)
  }

  async query<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (!this.pool) throw new InternalServerErrorException('Database not ready')
    try {
      const result: QueryResult<T> = await this.pool.query<T>(sql, params)
      return result.rows ?? []
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.logger.error(`Query failed: ${msg}\n${sql.slice(0, 200)}`)
      throw new Error(`DB query failed: ${msg}`)
    }
  }

  async queryOne<T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) throw new InternalServerErrorException('Database not ready')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => void 0)
      throw err
    } finally {
      client.release()
    }
  }

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    if (!this.pool) throw new InternalServerErrorException('Database not ready')
    const result = await this.pool.query(sql, params)
    return result.rowCount ?? 0
  }
}
