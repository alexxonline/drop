import crypto from 'node:crypto'
import { config } from './config.ts'
import { drops } from './db.ts'
import type { Drop, NewDrop } from './db.ts'
import { putObject, deletePrefix } from './r2.ts'
import { makePreview, previewKey, PREVIEW_MIME } from './preview.ts'
import type { Preview } from './preview.ts'
import { classify, sanitiseFilename, siteAssetType, SITE_KINDS } from './types.ts'
import type { DropKind } from './types.ts'
import { extractSite } from './zip.ts'

export class UploadError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'UploadError'
    this.statusCode = statusCode
  }
}

/**
 * Caps concurrent uploads. Each one buffers the whole file to memory so the
 * SigV4 payload hash can be computed, and MAX_UPLOAD_BYTES is 100 MB.
 */
class Semaphore {
  #free: number
  #waiting: Array<() => void> = []

  constructor(limit: number) {
    this.#free = limit
  }

  async acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1
      return
    }
    await new Promise<void>((resolve) => this.#waiting.push(resolve))
  }

  release(): void {
    const next = this.#waiting.shift()
    if (next) next()
    else this.#free += 1
  }
}

const slots = new Semaphore(config.uploadConcurrency)

interface PendingObject {
  key: string
  data: Buffer
  contentType: string
}

async function uploadAll(objects: PendingObject[], concurrency = 6): Promise<void> {
  const queue = [...objects]

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    let next: PendingObject | undefined
    while ((next = queue.pop()) !== undefined) {
      await putObject(next.key, next.data, next.contentType)
    }
  })
  await Promise.all(workers)
}

export interface StoreUploadInput {
  buffer: Buffer
  filename: string
  ownerEmail: string
  ttlSeconds: number
}

/**
 * Stores one upload: validates the type, writes every object under a single
 * `drops/<id>/` prefix, then records the metadata. If any write fails the whole
 * prefix is swept so a half-written drop never becomes reachable.
 */
export async function storeUpload({
  buffer,
  filename,
  ownerEmail,
  ttlSeconds,
}: StoreUploadInput): Promise<NewDrop> {
  const type = classify(filename)
  if (!type) {
    const what = filename.includes('.')
      ? `of type ".${filename.split('.').pop()}"`
      : 'without an extension'
    throw new UploadError(415, `Files ${what} are not supported.`)
  }
  if (buffer.length === 0) throw new UploadError(400, 'That file is empty.')

  const id = crypto.randomUUID()
  const prefix = `drops/${id}/`
  const safeName = sanitiseFilename(filename)

  await slots.acquire()
  try {
    const objects: PendingObject[] = []
    let entryCount = 1
    let objectKey: string
    let preview: Preview | null = null

    if (type.kind === 'site') {
      const { files } = await extractSite(buffer)
      entryCount = files.length
      objectKey = `${prefix}original/${safeName}`

      for (const file of files) {
        objects.push({
          key: `${prefix}site/${file.path}`,
          data: file.data,
          contentType: siteAssetType(file.path),
        })
      }
      // Kept alongside the unpacked site so the top bar can still offer a download.
      objects.push({ key: objectKey, data: buffer, contentType: type.mime })
    } else if (type.kind === 'html') {
      objectKey = `${prefix}site/index.html`
      objects.push({ key: objectKey, data: buffer, contentType: type.mime })
    } else {
      objectKey = `${prefix}${safeName}`
      objects.push({ key: objectKey, data: buffer, contentType: type.mime })

      if (type.kind === 'image') {
        try {
          preview = await makePreview(buffer)
          objects.push({
            key: previewKey(prefix),
            data: preview.data,
            contentType: PREVIEW_MIME,
          })
        } catch {
          // A share-card thumbnail is a nicety. An image sharp cannot decode
          // still uploads and still renders in the viewer; it just gets a
          // text-only preview when the link is pasted into a chat app.
          preview = null
        }
      }
    }

    try {
      await uploadAll(objects)
    } catch (err) {
      await deletePrefix(prefix).catch(() => {})
      throw err
    }

    const now = Date.now()
    return drops.create({
      id,
      ownerEmail,
      filename: safeName,
      kind: type.kind,
      mime: type.mime,
      size: buffer.length,
      objectKey,
      prefix,
      entryCount,
      previewWidth: preview?.width ?? null,
      previewHeight: preview?.height ?? null,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
    })
  } finally {
    slots.release()
  }
}

/** Removes every object for a drop and tombstones the row. Safe to repeat. */
export async function destroyDrop(drop: Drop): Promise<void> {
  await deletePrefix(drop.prefix)
  drops.markDeleted(drop.id)
}

/** Shape returned to the uploader and the dashboard. */
export interface OwnerView {
  id: string
  url: string
  filename: string
  kind: DropKind
  mime: string
  size: number
  entryCount: number
  createdAt: number
  expiresAt: number
}

export function toOwnerView(drop: NewDrop): OwnerView {
  return {
    id: drop.id,
    url: `${config.appOrigin}/d/${drop.id}`,
    filename: drop.filename,
    kind: drop.kind,
    mime: drop.mime,
    size: drop.size,
    entryCount: drop.entryCount,
    createdAt: drop.createdAt,
    expiresAt: drop.expiresAt,
  }
}

/** Shape returned to anonymous visitors of a link. */
export interface PublicView {
  id: string
  filename: string
  kind: DropKind
  mime: string
  size: number
  entryCount: number
  expiresAt: number
  contentUrl: string
  downloadUrl: string
}

export function toPublicView(drop: Drop): PublicView {
  const base = config.contentOrigin
  return {
    id: drop.id,
    filename: drop.filename,
    kind: drop.kind,
    mime: drop.mime,
    size: drop.size,
    entryCount: drop.entryCount,
    expiresAt: drop.expiresAt,
    contentUrl: SITE_KINDS.has(drop.kind) ? `${base}/s/${drop.id}/` : `${base}/f/${drop.id}`,
    downloadUrl: `${base}/f/${drop.id}?download=1`,
  }
}
