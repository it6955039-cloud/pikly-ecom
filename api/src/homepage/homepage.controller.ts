import { Controller, Get, Query } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger'
import { HomepageService } from './homepage.service'
import { successResponse } from '../common/api-utils'

@ApiTags('Homepage')
@Controller('homepage')
export class HomepageController {
  constructor(private readonly homepageService: HomepageService) {}

  @Get()
  @ApiOperation({
    summary: 'Get full homepage data (hero, categories, deals, new arrivals, etc.)',
  })
  async getHomepage() {
    const result = await this.homepageService.getHomepage()
    const { cacheHit, ...data } = result
    return successResponse(data, { cacheHit })
  }

  @Get('banners')
  @ApiOperation({
    summary: 'Get banners — filter by position (hero | sidebar | category_top)',
  })
  @ApiQuery({ name: 'position', required: false })
  async getBanners(@Query('position') position?: string) {
    return successResponse(await this.homepageService.getBanners(position))
  }
}
