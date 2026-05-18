import sharp from 'sharp'
import { createLogger } from '../logger.js'

const log = createLogger('COMPRESS_CTX')

const MAX_DIMENSION = 768
const JPEG_QUALITY = 80

export interface CompressedImage {
  base64: string
  mediaType: 'image/jpeg'
  byteSize: number
}

export async function compressForContext(
  imageBytes: Buffer,
): Promise<CompressedImage | null> {
  try {
    const buf = await sharp(imageBytes, { animated: false, limitInputPixels: false })
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer()

    return {
      base64: buf.toString('base64'),
      mediaType: 'image/jpeg',
      byteSize: buf.byteLength,
    }
  } catch (err) {
    log.warn({ err }, 'compress_for_context_failed')
    return null
  }
}
