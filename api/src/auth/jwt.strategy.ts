// src/auth/jwt.strategy.ts
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { ConfigService } from '@nestjs/config'
import { RedisService }  from '../redis/redis.service'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly redis:  RedisService,
    private readonly config: ConfigService,
  ) {
    super({
      jwtFromRequest:   ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // Use ConfigService — not process.env — so tests can inject mock values
      secretOrKey:      config.get<string>('JWT_SECRET') ?? '',
    })
  }

  async validate(payload: any) {
    if (!payload?.sub) throw new UnauthorizedException()

    if (payload.jti) {
      const revoked = await this.redis.isTokenBlacklisted(payload.jti)
      if (revoked) {
        throw new UnauthorizedException({
          code:    'TOKEN_REVOKED',
          message: 'Token has been revoked. Please log in again.',
        })
      }
    }

    return {
      userId: payload.sub,
      email:  payload.email,
      role:   payload.role,
      jti:    payload.jti,
      exp:    payload.exp,
    }
  }
}
