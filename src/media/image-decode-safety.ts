import sharp, { type Metadata, type Sharp } from 'sharp'

export const MAX_IMAGE_DECODE_PIXELS = 40_000_000
export const MAX_IMAGE_DECODE_DIMENSION = 8_192

export type ImageDecodeSafetyCode =
  | 'image_pixel_limit_exceeded'
  | 'image_dimension_limit_exceeded'
  | 'image_dimensions_missing'

export class ImageDecodeSafetyError extends Error {
  readonly code: ImageDecodeSafetyCode
  readonly width?: number
  readonly height?: number

  constructor(
    code: ImageDecodeSafetyCode,
    message: string,
    dimensions: { width?: number; height?: number } = {},
  ) {
    super(message)
    this.name = 'ImageDecodeSafetyError'
    this.code = code
    this.width = dimensions.width
    this.height = dimensions.height
  }
}

export function openImageForSafeDecode(imageBytes: Buffer): Sharp {
  return sharp(imageBytes, {
    animated: false,
    limitInputPixels: MAX_IMAGE_DECODE_PIXELS,
  })
}

export async function readSafeImageMetadata(imageBytes: Buffer): Promise<Metadata> {
  let metadata: Metadata
  try {
    metadata = await openImageForSafeDecode(imageBytes).metadata()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/pixel limit|exceeds.*pixels/i.test(message)) {
      throw new ImageDecodeSafetyError(
        'image_pixel_limit_exceeded',
        `Image exceeds the ${MAX_IMAGE_DECODE_PIXELS} pixel decode limit`,
      )
    }
    throw error
  }

  assertSafeImageDimensions(metadata)
  return metadata
}

export function assertSafeImageDimensions(metadata: Pick<Metadata, 'width' | 'height'>): void {
  const width = metadata.width
  const height = metadata.height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width! <= 0 || height! <= 0) {
    throw new ImageDecodeSafetyError(
      'image_dimensions_missing',
      'Image dimensions are missing or invalid',
      { width, height },
    )
  }
  if (width! > MAX_IMAGE_DECODE_DIMENSION || height! > MAX_IMAGE_DECODE_DIMENSION) {
    throw new ImageDecodeSafetyError(
      'image_dimension_limit_exceeded',
      `Image dimensions ${width}x${height} exceed the ${MAX_IMAGE_DECODE_DIMENSION}px edge limit`,
      { width, height },
    )
  }
  if (width! * height! > MAX_IMAGE_DECODE_PIXELS) {
    throw new ImageDecodeSafetyError(
      'image_pixel_limit_exceeded',
      `Image dimensions ${width}x${height} exceed the ${MAX_IMAGE_DECODE_PIXELS} pixel decode limit`,
      { width, height },
    )
  }
}
