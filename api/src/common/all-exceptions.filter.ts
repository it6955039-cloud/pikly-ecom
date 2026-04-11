import {
  ExceptionFilter, Catch, ArgumentsHost,
  HttpException, HttpStatus, Logger,
} from '@nestjs/common'

// A single filter that handles every unhandled exception so the client always
// receives a predictable JSON envelope instead of raw stack traces or HTML.
// PostgreSQL-specific error codes (23xxx constraint violations) are mapped to
// meaningful HTTP responses. All Mongoose-specific branches have been removed.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx     = host.switchToHttp()
    const res     = ctx.getResponse()
    const req     = ctx.getRequest()

    let status  = HttpStatus.INTERNAL_SERVER_ERROR
    let message = 'Internal server error'
    let code    = 'INTERNAL_ERROR'

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const body = exception.getResponse() as any
      if (typeof body === 'string') {
        message = body
      } else {
        // NestJS ValidationPipe wraps messages in an array
        message = Array.isArray(body?.message)
          ? body.message.join('; ')
          : (body?.message ?? exception.message)
        code = body?.code ?? 'HTTP_ERROR'
      }
    } else if (this.isPgError(exception)) {
      // PostgreSQL driver error — map constraint codes to HTTP semantics
      const pgCode = (exception as any).code as string
      if (pgCode === '23505') {
        // unique_violation — a UNIQUE constraint was violated
        status  = HttpStatus.CONFLICT
        message = 'A record with this value already exists'
        code    = 'DUPLICATE_KEY'
      } else if (pgCode === '23503') {
        // foreign_key_violation
        status  = HttpStatus.UNPROCESSABLE_ENTITY
        message = 'Referenced record does not exist'
        code    = 'FOREIGN_KEY_VIOLATION'
      } else if (pgCode === '23514') {
        // check_violation
        status  = HttpStatus.BAD_REQUEST
        message = 'Value failed database check constraint'
        code    = 'CHECK_VIOLATION'
      } else if (pgCode === '22P02') {
        // invalid_text_representation (e.g. bad UUID)
        status  = HttpStatus.BAD_REQUEST
        message = 'Invalid value format'
        code    = 'INVALID_FORMAT'
      } else {
        this.logger.error(`Unhandled PG error ${pgCode}: ${(exception as any).message}`)
      }
    } else {
      // Unexpected error — log full stack, return generic 500
      this.logger.error(
        `Unhandled exception on ${req.method} ${req.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      )
    }

    res.status(status).json({
      success:   false,
      code,
      message,
      path:      req.url,
      timestamp: new Date().toISOString(),
    })
  }

  private isPgError(e: unknown): boolean {
    // pg driver errors have a `code` property that is a 5-char string
    return (
      typeof e === 'object' &&
      e !== null &&
      typeof (e as any).code === 'string' &&
      /^[0-9A-Z]{5}$/.test((e as any).code)
    )
  }
}
