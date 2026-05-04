/**
 * @file users.module.ts  ← REPLACE src/users/users.module.ts
 * Change: add IdentityModule to imports (provides RequireAuthGuard, JitProvisioningGuard)
 */
import { Module }         from '@nestjs/common'
import { UsersService }   from './users.service'
import { UsersController } from './users.controller'
import { IdentityModule } from '../identity/identity.module'

@Module({
  imports:     [IdentityModule],
  providers:   [UsersService],
  controllers: [UsersController],
  exports:     [UsersService],
})
export class UsersModule {}
