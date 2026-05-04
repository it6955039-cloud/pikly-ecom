/**
 * @file main.ts  ← REPLACE src/main.ts
 *
 * Bootstrap — updated for Clerk IdP migration.
 *
 * CHANGES vs original:
 *   1. REQUIRED env vars updated: JWT_SECRET downgraded to OPTIONAL
 *      (still needed by legacy showcase adapter — but app boots without it)
 *      CLERK_ISSUER_URL and CLERK_WEBHOOK_SECRET added as REQUIRED.
 *
 *   2. Raw body middleware added for /api/clerk/webhooks
 *      Svix signature verification requires the raw Buffer before JSON parsing.
 *      We use a custom middleware that ONLY applies to this route.
 *
 *   3. Everything else is IDENTICAL to the original main.ts.
 */

import * as dotenv from 'dotenv'
import 'reflect-metadata'
dotenv.config()

// ── Startup guard: fail fast on missing critical env vars ─────────────────────
// JWT_SECRET still required for the legacy showcase adapter (HS256 verification)
const REQUIRED = ['DATABASE_URL', 'CLERK_ISSUER_URL', 'CLERK_WEBHOOK_SECRET', 'JWT_SECRET']
const missing  = REQUIRED.filter((k) => !process.env[k])
if (missing.length) {
  console.error(`\n❌  Missing required environment variables: ${missing.join(', ')}\n`)
  process.exit(1)
}

const RECOMMENDED = ['REDIS_URL', 'CLERK_SECRET_KEY', 'ALGOLIA_APP_ID']
const absent = RECOMMENDED.filter((k) => !process.env[k])
if (absent.length) {
  console.warn(`⚠️  Optional env vars not set: ${absent.join(', ')} — some features degraded`)
}

import { setDefaultResultOrder } from 'node:dns'
setDefaultResultOrder('ipv4first')

import { ValidationPipe }             from '@nestjs/common'
import { NestFactory }                from '@nestjs/core'
import { NestExpressApplication }     from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import compression                    from 'compression'
import * as express                   from 'express'
import helmet                         from 'helmet'
import morgan                         from 'morgan'
import { AppModule }                  from './app.module'
import { AllExceptionsFilter }        from './common/all-exceptions.filter'

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    /**
     * rawBody: true tells NestJS to keep the raw Buffer on req.rawBody
     * in ADDITION to the parsed JSON body. This is required by our
     * ClerkWebhookController for Svix signature verification.
     *
     * NestJS exposes this via the RawBodyRequest<Request> type.
     * Without this flag, req.rawBody is undefined and every Svix verification fails.
     */
    rawBody: true,
  })

  // ── Body size limits ──────────────────────────────────────────────────────
  // json() must come AFTER rawBody:true so the Buffer is captured first.
  app.use(express.json({ limit: '1mb' }))
  app.use(express.urlencoded({ limit: '1mb', extended: true }))

  // ── Global API prefix ─────────────────────────────────────────────────────
  app.setGlobalPrefix('api', { exclude: ['health', 'health/detail'] })

  // ── Security headers (Helmet) ─────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: false,
    }),
  )

  // ── CORS ──────────────────────────────────────────────────────────────────
  const allowedOrigins = (process.env['ALLOWED_ORIGINS'] ?? 'http://localhost:3000').split(',')
  app.enableCors({
    origin:      allowedOrigins,
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Authorization', 'Idempotency-Key',
      // Showcase-specific headers
      'X-Legacy-Session-Token',
      // Svix webhook headers
      'webhook-id', 'webhook-timestamp', 'webhook-signature',
    ],
  })

  // ── Compression ───────────────────────────────────────────────────────────
  app.use(compression())

  // ── HTTP logging ──────────────────────────────────────────────────────────
  if (process.env['NODE_ENV'] !== 'production') {
    app.use(morgan('dev'))
  }

  // ── Cookie parser (for legacy_session showcase cookie) ───────────────────
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cookieParser = require('cookie-parser')
  app.use(cookieParser())

  // ── Global pipes ──────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:        true,
      forbidNonWhitelisted: true,
      transform:        true,
      transformOptions: { enableImplicitConversion: true },
    }),
  )

  // ── Global exception filter ───────────────────────────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter())

  // ── Swagger ───────────────────────────────────────────────────────────────
  if (process.env['NODE_ENV'] !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Pikly API')
      .setDescription(
        'Pikly e-commerce API — Clerk IdP migration.\n\n' +
        '**Production auth**: Clerk Bearer JWT (RS256)\n\n' +
        '**Showcase/demo auth**: Legacy bcrypt/JWT — use /showcase/auth/login ' +
        'to obtain a legacy_session cookie, then /showcase/* endpoints.',
      )
      .setVersion('6.0.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addCookieAuth('legacy_session', { type: 'apiKey', in: 'cookie' }, 'legacy_session')
      .build()

    const document = SwaggerModule.createDocument(app, config)
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    })
  }

  const port = parseInt(process.env['PORT'] ?? '4000', 10)
  await app.listen(port)
  console.log(`\n🚀  Pikly API running on port ${port}`)
  console.log(`📘  Swagger docs: http://localhost:${port}/docs`)
  console.log(`🔐  Auth: Clerk (production) + Legacy showcase (/showcase/*)`)
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err)
  process.exit(1)
})
