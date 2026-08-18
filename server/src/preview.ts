import sharp from 'sharp'

/**
 * Link previews in chat apps are fetched by the platform, not the recipient,
 * and the fetchers are strict: WhatsApp silently shows no thumbnail once the
 * image passes roughly 600 KB, which most phone photos do several times over.
 * So an image drop gets a downscaled JPEG stored beside the original, and that
 * is what `og:image` points at.
 */
const MAX_PREVIEW_BYTES = 500 * 1024

/** Progressively harder squeezes; the first result that fits is kept. */
const ATTEMPTS = [
  { edge: 1200, quality: 80 },
  { edge: 1200, quality: 62 },
  { edge: 800, quality: 55 },
  { edge: 600, quality: 45 },
]

/** The object name under a drop's prefix; `previewKey` builds the full key. */
const PREVIEW_OBJECT = 'preview.jpg'

export const PREVIEW_MIME = 'image/jpeg'

export function previewKey(prefix: string): string {
  return `${prefix}${PREVIEW_OBJECT}`
}

export interface Preview {
  data: Buffer
  width: number
  height: number
}

/**
 * Renders a share-card thumbnail from image bytes. Throws if the bytes are not
 * a decodable image — callers treat that as "no preview", never as a failed
 * upload.
 */
export async function makePreview(buffer: Buffer): Promise<Preview> {
  let last: Preview | null = null

  for (const attempt of ATTEMPTS) {
    const { data, info } = await sharp(buffer)
      // EXIF orientation is baked in here; the thumbnail carries no metadata,
      // so a rotated phone photo would otherwise preview on its side.
      .rotate()
      .resize({
        width: attempt.edge,
        height: attempt.edge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: attempt.quality, progressive: true, mozjpeg: true })
      .toBuffer({ resolveWithObject: true })

    last = { data, width: info.width, height: info.height }
    if (data.length <= MAX_PREVIEW_BYTES) return last
  }

  // Even the smallest attempt overshot: send it anyway rather than nothing.
  return last!
}
