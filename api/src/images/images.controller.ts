import { Controller, Get, Query } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger'
import { ImagesService } from './images.service'

@ApiTags('Images')
@Controller('images')
export class ImagesController {
  constructor(private readonly imagesService: ImagesService) {}

  @Get()
  @ApiOperation({
    summary:
      'Get all product images grouped by category — supports offset (page) and cursor pagination',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number — use either page OR cursor, not both',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Items per page (default: 10)',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Cursor from previous response for cursor pagination',
  })
  getImages(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('cursor') cursor?: string,
  ) {
    const result = this.imagesService.getImages({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? undefined,
    })

    return {
      success: true,
      data: {
        imagesData: result.imagesData,
      },
      meta: {
        totalProducts: result.totalProducts,
        limit: result.limit,
        hasNextPage: result.hasNextPage,
        hasPrevPage: result.hasPrevPage,
        mode: result.mode,
        // offset fields
        ...(result.mode === 'offset' && {
          currentPage: result.currentPage,
          totalPages: result.totalPages,
          nextPage: result.nextPage,
          prevPage: result.prevPage,
        }),
        // cursor fields
        ...(result.mode === 'cursor' && {
          nextCursor: result.nextCursor,
          prevCursor: result.prevCursor,
        }),
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    }
  }
}
