import * as dotenv from 'dotenv'
import 'reflect-metadata'
dotenv.config()

// ── Startup guard: fail fast on missing critical env vars ─────────────────────
const REQUIRED = ['DATABASE_URL', 'JWT_SECRET']
const missing  = REQUIRED.filter((k) => !process.env[k])
if (missing.length) {
  console.error(`\n❌  Missing required environment variables: ${missing.join(', ')}\n`)
  process.exit(1)
}

// Warn about optional but strongly recommended vars
const RECOMMENDED = ['REDIS_URL', 'JWT_REFRESH_SECRET', 'ALGOLIA_APP_ID']
const absent = RECOMMENDED.filter((k) => !process.env[k])
if (absent.length) {
  console.warn(`⚠️  Optional env vars not set: ${absent.join(', ')} — some features degraded`)
}

import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import { ValidationPipe }         from '@nestjs/common'
import { NestFactory }            from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import compression                from 'compression'
import * as express               from 'express'
import helmet                     from 'helmet'
import morgan                     from 'morgan'
import { AppModule }              from './app.module'
import { AllExceptionsFilter }    from './common/all-exceptions.filter'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  })

  // ── Body size limits ────────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ limit: '1mb', extended: true }))

  // NOTE: Static file serving for /uploads has been removed.
  // Images are stored on Cloudinary (persistent CDN) via POST /admin/upload.
  // Cloudinary URLs survive Railway deploys and horizontal scaling.

  // ── Global API prefix ───────────────────────────────────────────────────
  app.setGlobalPrefix('api', { exclude: ['health', 'health/detail'] })

  // ── CORS ─────────────────────────────────────────────────────────────────
  //
  // Strategy:
  //   • Production  → only origins listed in ALLOWED_ORIGINS pass.
  //   • Development → any localhost origin is also allowed automatically,
  //                   so Next.js (:3000), Vite (:5173), Angular (:4200), etc.
  //                   all work without touching env files.
  //   • Server-to-server / curl / Postman → no Origin header → always allowed
  //                   (they are not subject to browser CORS policy).
  //
  // ALLOWED_ORIGINS must be a comma-separated list of full origins, e.g.:
  //   ALLOWED_ORIGINS=https://pikly.com,https://www.pikly.com,https://admin.pikly.com
  //
  const isProd = process.env['NODE_ENV'] === 'production'

  const explicitOrigins: string[] = (process.env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // Matches any http/https localhost origin regardless of port number
  const LOCALHOST_ORIGIN_RE = /^https?:\/\/localhost(:\d+)?$/

  function corsOriginValidator(
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ): void {
    // No Origin header → non-browser caller (curl, Postman, server) → allow
    if (!origin) return callback(null, true)

    // Explicitly whitelisted origin (works in both dev & prod)
    if (explicitOrigins.includes(origin)) return callback(null, true)

    // In development, allow any localhost port automatically
    if (!isProd && LOCALHOST_ORIGIN_RE.test(origin)) return callback(null, true)

    // Blocked — log so Railway/server logs make the denial visible
    console.warn(`🚫  CORS blocked origin: "${origin}"`)
    return callback(new Error(`CORS: origin "${origin}" is not permitted`))
  }

  app.enableCors({
    origin:         corsOriginValidator,
    methods:        ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-ID', 'Idempotency-Key'],
    exposedHeaders: ['X-Total-Count'],   // lets frontend read pagination totals from headers
    credentials:    true,                // required for Authorization header & cookie flows
    maxAge:         86_400,              // cache OPTIONS preflight 24 h → fewer round-trips
  })

  // ── Security / compression / logging ────────────────────────────────────
  // helmet is applied AFTER enableCors so CORS headers are already committed.
  // crossOriginResourcePolicy is set to cross-origin so CDN assets (Cloudinary)
  // and API responses are not blocked by the browser's CORP enforcement.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
  app.use(compression())
  app.use(morgan(process.env['NODE_ENV'] === 'production' ? 'combined' : 'dev'))

  // ── Global exception filter ──────────────────────────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter())

  // ── Validation ──────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:            true,
      transform:            true,
      forbidNonWhitelisted: true,
    }),
  )

  // ── Swagger (dev only — set SWAGGER_ENABLED=true in .env) ────────────────
  if (process.env['SWAGGER_ENABLED'] === 'true') {
    const config = new DocumentBuilder()
      .setTitle('Pikly Store API')
      .setDescription(
        'Enterprise eCommerce REST API — NestJS + Neon PostgreSQL + Algolia + Redis + CIL',
      )
      .setVersion('5.0.0')
      .addBearerAuth()
      .build()
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(app, config),
      { swaggerOptions: { persistAuthorization: true } },
    )
    console.log(`📖  Swagger → http://localhost:${process.env['PORT'] ?? 3000}/api/docs`)
  }

  const port = process.env['PORT'] ?? 3000

  await app.listen(port)
  console.log(`\n🚀  Pikly Store API v5.0.0 → http://localhost:${port}\n`)
}

bootstrap().catch((err) => {
  console.error('❌  Fatal startup error:', err)
  process.exit(1)
})
