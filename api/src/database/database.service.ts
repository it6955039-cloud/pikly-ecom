// src/database/database.service.ts
import {
  Injectable, Logger, OnModuleInit, OnModuleDestroy, InternalServerErrorException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

// WHY standard pg instead of @neondatabase/serverless:
// @neondatabase/serverless Pool uses WebSockets internally.
// Node.js 20 has no built-in WebSocket — without explicitly setting
// neonConfig.webSocketConstructor = ws, every pool.query() call silently
// hangs forever. Standard pg uses TCP which works on all Node versions.
// Neon accepts standard TCP connections on port 5432 (direct) with sslmode=require.

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name)
  private pool: Pool | null = null

  private _readyResolve!: () => void
  private _readyReject!:  (err: Error) => void
  private readonly _ready = new Promise<void>((res, rej) => {
    this._readyResolve = res
    this._readyReject  = rej
  })

  waitUntilReady(): Promise<void> { return this._ready }

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const dsn = this.config.get<string>('DATABASE_URL')
    if (!dsn) {
      const err = new Error('DATABASE_URL is required')
      this._readyReject(err)
      this.logger.error('DATABASE_URL not set')
      throw err
    }

    this.pool = new Pool({
      connectionString:        dsn,
      max:                     10,
      idleTimeoutMillis:       30_000,
      connectionTimeoutMillis: 10_000,
      // Neon PostgreSQL uses AWS-issued certificates trusted by Node's built-in
      // CA bundle.  rejectUnauthorized: true (the default) verifies the cert chain
      // and protects against MITM attacks.  We set it explicitly so the intent is clear.
      ssl:                     { rejectUnauthorized: true },
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