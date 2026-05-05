import { Module }                 from '@nestjs/common'
import { ShowcaseAuthController } from '../identity/clerk/showcase-auth.controller'
import { ShowcaseController }     from './showcase.controller'
import { IdentityModule }         from '../identity/identity.module'
import { LegacyShowcaseAdapter }  from '../identity/adapters/legacy-showcase.adapter'

@Module({
  imports:     [IdentityModule],
  controllers: [ShowcaseAuthController, ShowcaseController],
  /**
   * LegacyShowcaseAdapter must be listed here directly because
   * ShowcaseAuthController injects it by class reference (not by the
   * SHOWCASE_IDENTITY_SERVICE string token that IdentityModule uses).
   * Adding it here makes NestJS resolve it within the ShowcaseModule context.
   */
  providers:   [LegacyShowcaseAdapter],
})
export class ShowcaseModule {}
