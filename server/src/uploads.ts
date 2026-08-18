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
import type { ExtractedSite } from './zip.ts'

export class UploadError extends Error {
  readonly statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'UploadError'
    this.statusCode = statusCode
  }
}

/**
 * Admission control for the memory an upload occupies while it is in flight.
 *
 * Every upload is buffered whole — the SigV4 payload hash needs the bytes up
 * front — so the ceiling has to be counted in bytes rather than in requests:
 * capping the number of concurrent uploads bounds nothing when each one may be
 * 100 MB, and makes small uploads queue behind each other for no reason.
 * Callers reserve before they read, and wait when the budget is spent.
 */
class ByteBudget {
  readonly #limit: number
  #free: number
  #waiting: Array<{ size: number; wake: () => void }> = []

  constructor(limit: number) {
    this.#limit = limit
    this.#free = limit
  }

  /** Resolves once `size` bytes are held, and returns the amount to release. */
  async acquire(size: number): Promise<number> {
    const want = Math.min(Math.max(size, 0), this.#limit)

    if (this.#waiting.length === 0 && want <= this.#free) {
      this.#free -= want
      return want
    }
    await new Promise<void>((wake) => this.#waiting.push({ size: want, wake }))
    return want
  }

  release(size: number): void {
    this.#free += size

    // Strictly in order, even when a smaller request further back would fit:
    // letting it barge means a steady trickle of small uploads can starve a
    // large one indefinitely.
    while (this.#waiting.length > 0 && this.#waiting[0]!.size <= this.#free) {
      const next = this.#waiting.shift()!
      this.#free -= next.size
      next.wake()
    }
  }
}

const budget = new ByteBudget(config.uploadMemoryBudgetBytes)

/**
 * Runs `fn` with room for `size` bytes reserved.
 *
 * `size` comes from the request's own Content-Length, so a client that lies
 * under-reserves; the per-request MAX_UPLOAD_BYTES limit still caps what any
 * one upload can actually buffer, and uploads are rate limited on top.
 */
export async function withUploadBudget<T>(size: number, fn: () => Promise<T>): Promise<T> {
  const reserved = await budget.acquire(size)
  try {
    return await fn()
  } finally {
    budget.release(reserved)
  }
}

interface PendingObject {
  key: string
  read: () => Promise<Buffer>
  contentType: string
}

/**
 * Writes objects to R2, at most `objectConcurrency` at a time. Bytes are read
 * inside the worker that uploads them, so a 2000-entry site holds a handful of
 * buffers in memory rather than all of them.
 */
async function uploadAll(objects: PendingObject[]): Promise<void> {
  const queue = [...objects]
  const width = Math.min(config.objectConcurrency, queue.length)

  const workers = Array.from({ length: width }, async () => {
    let next: PendingObject | undefined
    while ((next = queue.pop()) !== undefined) {
      await putObject(next.key, await next.read(), next.contentType)
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

  const objects: PendingObject[] = []
  const whole = async () => buffer
  let entryCount = 1
  let objectKey: string
  let preview: Preview | null = null
  let site: ExtractedSite | null = null

  if (type.kind === 'site') {
    site = await extractSite(buffer)
    entryCount = site.entries.length
    objectKey = `${prefix}original/${safeName}`

    for (const entry of site.entries) {
      objects.push({
        key: `${prefix}site/${entry.path}`,
        read: entry.read,
        contentType: siteAssetType(entry.path),
      })
    }
    // Kept alongside the unpacked site so the top bar can still offer a download.
    objects.push({ key: objectKey, read: whole, contentType: type.mime })
  } else if (type.kind === 'html') {
    objectKey = `${prefix}site/index.html`
    objects.push({ key: objectKey, read: whole, contentType: type.mime })
  } else {
    objectKey = `${prefix}${safeName}`
    objects.push({ key: objectKey, read: whole, contentType: type.mime })

    if (type.kind === 'image') {
      try {
        preview = await makePreview(buffer)
        const data = preview.data
        objects.push({
          key: previewKey(prefix),
          read: async () => data,
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
  } finally {
    site?.close()
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
