// src/uploads/uploads.module.ts  ← REPLACE
// Change: add IdentityModule so RequireRoleGuard + JitProvisioningGuard resolve.
import { Module }           from '@nestjs/common'
import { UploadsController } from './uploads.controller'
import { IdentityModule }   from '../identity/identity.module'

@Module({
  imports:     [IdentityModule],
  controllers: [UploadsController],
})
export class UploadsModule {}
