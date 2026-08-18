import { AwsClient } from 'aws4fetch'
import { config } from './config.ts'

const endpoint = `https://${config.r2.accountId}.r2.cloudflarestorage.com`

const client = new AwsClient({
  accessKeyId: config.r2.accessKeyId,
  secretAccessKey: config.r2.secretAccessKey,
  service: 's3',
  region: 'auto',
})

/** Percent-encodes each path segment while leaving the separators intact. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function objectUrl(key: string): string {
  return `${endpoint}/${encodeURIComponent(config.r2.bucket)}/${encodeKey(key)}`
}

export class R2Error extends Error {
  readonly status: number

  constructor(operation: string, key: string, status: number, body: string) {
    super(`R2 ${operation} failed for ${key}: ${status} ${body.slice(0, 300)}`)
    this.name = 'R2Error'
    this.status = status
  }
}

async function assertOk(res: Response, operation: string, key: string): Promise<Response> {
  if (res.ok) return res
  const body = await res.text().catch(() => '')
  throw new R2Error(operation, key, res.status, body)
}

export async function putObject(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<Response> {
  const res = await client.fetch(objectUrl(key), {
    method: 'PUT',
    body,
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength),
    },
  })
  return assertOk(res, 'PUT', key)
}

export interface GetOptions {
  range?: string | undefined
}

/**
 * Fetches an object, optionally forwarding a Range header so audio seeking and
 * partial PDF loads work. Returns null on 404 rather than throwing, since a
 * missing site asset is an ordinary outcome.
 */
export async function getObject(key: string, { range }: GetOptions = {}): Promise<Response | null> {
  const headers: Record<string, string> = {}
  if (range) headers.range = range

  const res = await client.fetch(objectUrl(key), { method: 'GET', headers })
  if (res.status === 404) {
    await res.body?.cancel()
    return null
  }
  return assertOk(res, 'GET', key)
}

export async function deleteObject(key: string): Promise<void> {
  const res = await client.fetch(objectUrl(key), { method: 'DELETE' })
  // S3 delete is idempotent; 404 is success from our point of view.
  if (res.status === 404) return
  await assertOk(res, 'DELETE', key)
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}

function decodeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
}

/**
 * Lists every key under a prefix, following continuation tokens.
 *
 * Deletion works off a live listing rather than a manifest recorded at upload
 * time, so an upload interrupted halfway cannot strand objects in the bucket.
 */
export async function listPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined

  do {
    const url = new URL(`${endpoint}/${encodeURIComponent(config.r2.bucket)}`)
    url.searchParams.set('list-type', '2')
    url.searchParams.set('prefix', prefix)
    url.searchParams.set('max-keys', '1000')
    if (token) url.searchParams.set('continuation-token', token)

    const res = await assertOk(await client.fetch(url.toString()), 'LIST', prefix)
    const xml = await res.text()

    for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      keys.push(decodeXml(match[1]))
    }

    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml)
    const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)
    token = truncated && next ? decodeXml(next[1]) : undefined
  } while (token)

  return keys
}

/** Deletes everything under a prefix. Returns the number of objects removed. */
export async function deletePrefix(prefix: string): Promise<number> {
  const keys = await listPrefix(prefix)
  const queue = [...keys]

  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    let key: string | undefined
    while ((key = queue.pop()) !== undefined) {
      await deleteObject(key)
    }
  })
  await Promise.all(workers)

  return keys.length
}

/** Verifies credentials and bucket access at boot, so failures surface early. */
export async function checkConnection(): Promise<void> {
  const url = new URL(`${endpoint}/${encodeURIComponent(config.r2.bucket)}`)
  url.searchParams.set('list-type', '2')
  url.searchParams.set('max-keys', '1')
  await assertOk(await client.fetch(url.toString()), 'LIST', config.r2.bucket)
}
