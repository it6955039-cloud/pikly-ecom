import { Injectable } from '@nestjs/common'
import * as winston from 'winston'

const { combine, timestamp, printf, colorize, errors } = winston.format

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return stack
    ? `[${timestamp}] ${level}: ${message}\n${stack}`
    : `[${timestamp}] ${level}: ${message}`
})

@Injectable()
export class LoggerService {
  private logger: winston.Logger

  constructor() {
    this.logger = winston.createLogger({
      level: 'info',
      format: combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat,
      ),
      transports: [
        new winston.transports.Console({
          format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
        }),
      ],
    })
  }

  log(method: string, path: string, statusCode: number, ms: number) {
    this.logger.info(`${method} ${path} → ${statusCode} (${ms}ms)`)
  }

  info(message: string) {
    this.logger.info(message)
  }

  error(message: string, trace?: string) {
    this.logger.error(message, { stack: trace })
  }

  warn(message: string) {
    this.logger.warn(message)
  }

  cacheHit(key: string) {
    this.logger.info(`CACHE HIT  → ${key}`)
  }

  cacheMiss(key: string) {
    this.logger.info(`CACHE MISS → ${key}`)
  }
}
