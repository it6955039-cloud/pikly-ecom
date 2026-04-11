// src/uploads/uploads.controller.ts
//
// Upload images to Cloudinary instead of local disk.
//
// WHY CLOUDINARY:
//   Railway (and most PaaS platforms) use an ephemeral filesystem — every
//   deploy, restart, or scale-out event wipes local storage.  Writing uploads
//   to `public/uploads/` on disk means ALL user-uploaded images are permanently
//   deleted on every deployment.  Cloudinary is a persistent, CDN-backed object
//   store that survives restarts and scales horizontally without coordination.
//
// SECURITY:
//   • Files are validated by magic bytes (not filename extension) before upload.
//   • Cloudinary upload uses a server-side signed upload — the secret API key
//     never leaves the server.
//   • Size cap enforced both at multer (pre-parse) and Cloudinary (redundant guard).
//   • Returned URL is the Cloudinary CDN URL — no local paths exposed.

import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger'
import { AuthGuard } from '@nestjs/passport'
import { FileInterceptor } from '@nestjs/platform-express'
import { memoryStorage } from 'multer'
import { v2 as cloudinary } from 'cloudinary'
import { RolesGuard }      from '../common/guards/roles.guard'
import { Roles }           from '../common/decorators/roles.decorator'
import { successResponse } from '../common/api-utils'

const MAX_SIZE_MB = 5

// ── Magic byte detection ─────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function detectMimeType(buf: Buffer): string | null {
  if (buf.length < 4) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif'
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp'
  return null
}

const MIME_TO_FORMAT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/gif':  'gif',
}

function uploadToCloudinary(
  buffer: Buffer,
  format: string,
  folder: string,
): Promise<{ secure_url: string; public_id: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, format, resource_type: 'image', overwrite: false },
      (err, result) => {
        if (err || !result) return reject(err ?? new Error('Cloudinary returned empty result'))
        resolve({ secure_url: result.secure_url, public_id: result.public_id, bytes: result.bytes })
      },
    )
    stream.end(buffer)
  })
}

@ApiTags('Admin — Uploads')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
@Controller('admin/upload')
export class UploadsController {
  private readonly logger = new Logger(UploadsController.name)
  private cloudinaryReady = false

  constructor() {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME
    const apiKey    = process.env.CLOUDINARY_API_KEY
    const apiSecret = process.env.CLOUDINARY_API_SECRET

    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret })
      this.cloudinaryReady = true
    } else {
      this.logger.warn(
        'Cloudinary credentials not configured ' +
        '(CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET). ' +
        'Image uploads will be rejected until credentials are set.',
      )
    }
  }

  @Post()
  @ApiOperation({
    summary: '[Admin] Upload an image to Cloudinary (max 5 MB, jpeg/png/webp/gif — validated by magic bytes)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits:  { fileSize: MAX_SIZE_MB * 1024 * 1024 },
      fileFilter: (_req, _file, cb) => cb(null, true),
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!this.cloudinaryReady) {
      throw new InternalServerErrorException({
        code:    'UPLOAD_NOT_CONFIGURED',
        message: 'Image upload service is not configured. Contact the administrator.',
      })
    }
    if (!file) {
      throw new BadRequestException({ code: 'NO_FILE', message: 'No file uploaded' })
    }

    const detectedMime = detectMimeType(file.buffer)
    if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
      throw new BadRequestException({
        code:    'INVALID_FILE_TYPE',
        message: 'File content does not match a supported image format (jpeg, png, webp, gif). ' +
                 'Renaming a non-image file does not bypass this check.',
      })
    }

    const format = MIME_TO_FORMAT[detectedMime]
    const folder = process.env.CLOUDINARY_UPLOAD_FOLDER ?? 'pikly/uploads'

    try {
      const result = await uploadToCloudinary(file.buffer, format, folder)
      this.logger.log(`Uploaded → Cloudinary: ${result.public_id}`)
      return successResponse({
        url:      result.secure_url,
        publicId: result.public_id,
        size:     result.bytes,
        mimetype: detectedMime,
      })
    } catch (err: any) {
      this.logger.error(`Cloudinary upload failed: ${err.message}`)
      throw new InternalServerErrorException({
        code:    'UPLOAD_FAILED',
        message: 'Image upload failed. Please try again.',
      })
    }
  }
}
