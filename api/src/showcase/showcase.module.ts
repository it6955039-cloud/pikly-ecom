/**
 * @file showcase/showcase.module.ts
 *
 * ShowcaseModule — wires the dormant legacy authentication demo.
 * Routes prefixed /showcase/* — isolated from production via ShadowSessionMiddleware.
 */
import { Module }                 from '@nestjs/common'
import { ShowcaseAuthController } from '../identity/clerk/showcase-auth.controller'
import { ShowcaseController }     from './showcase.controller'
import { IdentityModule }         from '../identity/identity.module'

@Module({
  imports:     [IdentityModule],
  controllers: [ShowcaseAuthController, ShowcaseController],
})
export class ShowcaseModule {}
