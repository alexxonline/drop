import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SignJWT } from 'jose'
import sharp from 'sharp'
import { buildZip, SYMLINK_ATTRIBUTES } from './zip-builder.ts'
import type { OwnerView, PublicView } from '../src/uploads.ts'

const SECRET = 'test-secret-that-is-at-least-32-characters-long'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'))

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  APP_ORIGIN: 'http://app.test',
  CONTENT_ORIGIN: 'http://content.test',
  SESSION_SECRET: SECRET,
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  ALLOWED_EMAILS: 'owner@example.com,other@example.com',
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'test-bucket',
  DATABASE_PATH: path.join(TMP, 'test.db'),
  MAX_UPLOAD_BYTES: '10485760',
})

// --- in-memory stand-in for R2 ----------------------------------------------

interface StoredObject {
  data: Buffer
  contentType: string
}

const bucket = new Map<string, StoredObject>()

function objectResponse(key: string, range?: string): Response | null {
  const object = bucket.get(key)
  if (!object) return null

  const headers = { 'content-type': object.contentType, 'accept-ranges': 'bytes' }

  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (match) {
    const start = match[1] === '' ? 0 : Number(match[1])
    const end = match[2] === '' ? object.data.length - 1 : Number(match[2])
    const slice = object.data.subarray(start, end + 1)

    return new Response(slice, {
      status: 206,
      headers: {
        ...headers,
        'content-range': `bytes ${start}-${end}/${object.data.length}`,
        'content-length': String(slice.length),
      },
    })
  }

  return new Response(object.data, {
    status: 200,
    headers: { ...headers, 'content-length': String(object.data.length) },
  })
}

mock.module(new URL('../src/r2.ts', import.meta.url).href, {
  namedExports: {
    async putObject(key: string, body: Uint8Array, contentType: string) {
      bucket.set(key, { data: Buffer.from(body), contentType })
    },
    async getObject(key: string, { range }: { range?: string } = {}) {
      return objectResponse(key, range)
    },
    async deleteObject(key: string) {
      bucket.delete(key)
    },
    async listPrefix(prefix: string) {
      return [...bucket.keys()].filter((k) => k.startsWith(prefix))
    },
    async deletePrefix(prefix: string) {
      const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix))
      keys.forEach((k) => bucket.delete(k))
      return keys.length
    },
    async checkConnection() {},
  },
})

const { buildApp } = await import('../src/app.ts')
const { config } = await import('../src/config.ts')
const { withUploadBudget } = await import('../src/uploads.ts')
const { extractSite } = await import('../src/zip.ts')
const { default: db, drops } = await import('../src/db.ts')
const { startSweeper } = await import('../src/sweeper.ts')

const app = await buildApp()
await app.ready()

test.after(async () => {
  await app.close()
  db.close()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// --- helpers -----------------------------------------------------------------

async function sessionCookie(email = 'owner@example.com'): Promise<string> {
  const token = await new SignJWT({ email, name: 'Test Owner' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET))
  return `drop_session=${token}`
}

function multipart(filename: string, data: string | Buffer) {
  const boundary = '----dropTestBoundary000111'
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
    Buffer.isBuffer(data) ? data : Buffer.from(data),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { body, contentType: `multipart/form-data; boundary=${boundary}` }
}

const appHost = { host: 'app.test' }
const contentHost = { host: 'content.test' }

interface UploadOptions {
  ttl?: number
  email?: string
}

async function upload(
  filename: string,
  data: string | Buffer,
  { ttl = 3600, email }: UploadOptions = {},
) {
  const { body, contentType } = multipart(filename, data)
  return app.inject({
    method: 'POST',
    url: `/api/uploads?ttl=${ttl}`,
    headers: { ...appHost, 'content-type': contentType, cookie: await sessionCookie(email) },
    payload: body,
  })
}

/** Uploads and returns the parsed owner view, failing loudly on a non-201. */
async function uploadOk(
  filename: string,
  data: string | Buffer,
  options?: UploadOptions,
): Promise<OwnerView> {
  const res = await upload(filename, data, options)
  assert.equal(res.statusCode, 201, `upload of ${filename} failed: ${res.body}`)
  return res.json() as OwnerView
}

/** A genuinely decodable image, so the thumbnail pipeline runs for real. */
function samplePng(width = 1600, height = 900): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#c8285a' } })
    .png()
    .toBuffer()
}

function keysFor(id: string): string[] {
  return [...bucket.keys()].filter((k) => k.includes(id))
}

// --- tests -------------------------------------------------------------------

test('health check answers on any host', async () => {
  const res = await app.inject({ method: 'GET', url: '/health', headers: appHost })
  assert.equal(res.statusCode, 200)
})

test('exposes upload settings to the frontend', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/config', headers: appHost })
  assert.equal(res.statusCode, 200)

  const body = res.json()
  assert.ok(body.ttlChoices.length > 0)
  assert.ok(body.acceptedExtensions.includes('.md'))
  assert.equal(body.maxUploadBytes, 10485760)
})

test('sets a content security policy on app responses', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/config', headers: appHost })
  const csp = res.headers['content-security-policy'] as string
  assert.match(csp, /script-src 'self'/)
  assert.match(csp, /frame-src 'self' http:\/\/content\.test/)
})

test('rejects anonymous access to the API', async () => {
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: appHost })
  assert.equal(me.statusCode, 401)

  const { body, contentType } = multipart('a.txt', 'hello')
  const post = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { ...appHost, 'content-type': contentType },
    payload: body,
  })
  assert.equal(post.statusCode, 401)
})

test('rejects a session for an address that is not allowlisted', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { ...appHost, cookie: await sessionCookie('stranger@example.com') },
  })
  assert.equal(res.statusCode, 401)
})

test('rejects cross-origin state-changing requests', async () => {
  const { body, contentType } = multipart('a.txt', 'hello')
  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: {
      ...appHost,
      origin: 'http://evil.test',
      'content-type': contentType,
      cookie: await sessionCookie(),
    },
    payload: body,
  })
  assert.equal(res.statusCode, 403)
})

test('keeps the app and content hosts separate', async () => {
  const contentOnApp = await app.inject({ method: 'GET', url: '/f/anything', headers: appHost })
  assert.equal(contentOnApp.statusCode, 404)

  const apiOnContent = await app.inject({
    method: 'GET',
    url: '/api/config',
    headers: contentHost,
  })
  assert.equal(apiOnContent.statusCode, 404)
})

test('stores a text file and serves it from the content host', async () => {
  const drop = await uploadOk('notes.txt', 'hello there')
  assert.equal(drop.kind, 'text')
  assert.equal(drop.url, `http://app.test/d/${drop.id}`)

  const meta = await app.inject({ method: 'GET', url: `/api/drops/${drop.id}`, headers: appHost })
  assert.equal(meta.statusCode, 200)
  assert.equal((meta.json() as PublicView).contentUrl, `http://content.test/f/${drop.id}`)

  const file = await app.inject({ method: 'GET', url: `/f/${drop.id}`, headers: contentHost })
  assert.equal(file.statusCode, 200)
  assert.equal(file.body, 'hello there')
  assert.match(file.headers['content-type'] as string, /text\/plain/)
  assert.equal(file.headers['access-control-allow-origin'], 'http://app.test')
  assert.match(file.headers['content-disposition'] as string, /^inline/)
})

test('forces an attachment when download is requested', async () => {
  const drop = await uploadOk('notes.txt', 'hello there')
  const res = await app.inject({
    method: 'GET',
    url: `/f/${drop.id}?download=1`,
    headers: contentHost,
  })
  assert.match(res.headers['content-disposition'] as string, /^attachment/)
  assert.equal(res.headers['content-type'], 'application/octet-stream')
})

test('serves byte ranges so audio can seek', async () => {
  const drop = await uploadOk('clip.mp3', Buffer.from('0123456789'))
  const res = await app.inject({
    method: 'GET',
    url: `/f/${drop.id}`,
    headers: { ...contentHost, range: 'bytes=2-5' },
  })
  assert.equal(res.statusCode, 206)
  assert.equal(res.body, '2345')
  assert.equal(res.headers['content-range'], 'bytes 2-5/10')
})

test('refuses file types that are not on the list', async () => {
  const res = await upload('payload.exe', 'MZ')
  assert.equal(res.statusCode, 415)
})

test('refuses an empty file', async () => {
  const res = await upload('empty.txt', '')
  assert.equal(res.statusCode, 400)
})

test('clamps a TTL beyond the configured maximum', async () => {
  const before = Date.now()
  const drop = await uploadOk('notes.txt', 'x', { ttl: 99999999999 })
  // MAX_TTL_SECONDS defaults to 30 days.
  assert.ok(drop.expiresAt <= before + 30 * 24 * 3600 * 1000 + 5000)
})

test('serves a single HTML upload as a one-page site', async () => {
  const drop = await uploadOk('page.html', '<h1>hi</h1>')
  assert.equal(drop.kind, 'html')

  const meta = (
    await app.inject({ method: 'GET', url: `/api/drops/${drop.id}`, headers: appHost })
  ).json() as PublicView
  assert.equal(meta.contentUrl, `http://content.test/s/${drop.id}/`)

  const page = await app.inject({ method: 'GET', url: `/s/${drop.id}/`, headers: contentHost })
  assert.equal(page.statusCode, 200)
  assert.equal(page.body, '<h1>hi</h1>')
  assert.match(page.headers['content-type'] as string, /text\/html/)
  assert.match(
    page.headers['content-security-policy'] as string,
    /frame-ancestors 'self' http:\/\/app\.test/,
  )
})

test('unpacks a zip and serves it as a static site', async () => {
  const zip = buildZip([
    { name: 'index.html', data: '<link rel="stylesheet" href="style.css">home' },
    { name: 'style.css', data: 'body{color:red}' },
    { name: 'about/index.html', data: 'about page' },
    { name: '__MACOSX/._index.html', data: 'junk' },
  ])

  const drop = await uploadOk('site.zip', zip)
  assert.equal(drop.kind, 'site')
  // The junk entry is dropped; the original archive is kept for download.
  assert.equal(drop.entryCount, 3)

  const index = await app.inject({ method: 'GET', url: `/s/${drop.id}/`, headers: contentHost })
  assert.equal(index.statusCode, 200)
  assert.match(index.body, /home/)

  const css = await app.inject({
    method: 'GET',
    url: `/s/${drop.id}/style.css`,
    headers: contentHost,
  })
  assert.equal(css.statusCode, 200)
  assert.match(css.headers['content-type'] as string, /text\/css/)

  // Directory-style URL without a trailing slash still resolves.
  const about = await app.inject({
    method: 'GET',
    url: `/s/${drop.id}/about`,
    headers: contentHost,
  })
  assert.equal(about.statusCode, 200)
  assert.equal(about.body, 'about page')

  const missing = await app.inject({
    method: 'GET',
    url: `/s/${drop.id}/nope.html`,
    headers: contentHost,
  })
  assert.equal(missing.statusCode, 404)

  // The zip itself remains downloadable from the top bar.
  const download = await app.inject({
    method: 'GET',
    url: `/f/${drop.id}?download=1`,
    headers: contentHost,
  })
  assert.equal(download.statusCode, 200)
})

test('strips a single wrapper directory from a zip', async () => {
  const zip = buildZip([
    { name: 'my-site/index.html', data: 'wrapped' },
    { name: 'my-site/app.js', data: 'console.log(1)' },
  ])
  const drop = await uploadOk('site.zip', zip)

  const index = await app.inject({ method: 'GET', url: `/s/${drop.id}/`, headers: contentHost })
  assert.equal(index.body, 'wrapped')
})

test('rejects a zip containing a path traversal', async () => {
  const zip = buildZip([
    { name: 'index.html', data: 'ok' },
    { name: '../../etc/passwd', data: 'root:x:0:0' },
  ])
  const res = await upload('evil.zip', zip)
  assert.equal(res.statusCode, 400)
  // yauzl rejects these before our own check gets a look in; either is fine.
  assert.match(res.json().message, /traversal|relative path/)
})

test('rejects a zip containing an absolute path', async () => {
  const zip = buildZip([{ name: '/etc/shadow', data: 'nope' }])
  const res = await upload('evil.zip', zip)
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /absolute path/)
})

test('rejects a zip containing a symlink', async () => {
  const zip = buildZip([
    { name: 'index.html', data: 'ok' },
    { name: 'link', data: '/etc/passwd', externalAttributes: SYMLINK_ATTRIBUTES },
  ])
  const res = await upload('evil.zip', zip)
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /symlink/)
})

test('rejects a zip with no index.html', async () => {
  const zip = buildZip([{ name: 'readme.txt', data: 'no entry point' }])
  const res = await upload('site.zip', zip)
  assert.equal(res.statusCode, 400)
  assert.match(res.json().message, /index\.html/)
})

test('lists and deletes the caller’s own uploads', async () => {
  const drop = await uploadOk('mine.txt', 'private')

  const list = await app.inject({
    method: 'GET',
    url: '/api/uploads',
    headers: { ...appHost, cookie: await sessionCookie() },
  })
  assert.ok((list.json() as OwnerView[]).some((d) => d.id === drop.id))

  // Another allowlisted user cannot see or delete it.
  const otherList = await app.inject({
    method: 'GET',
    url: '/api/uploads',
    headers: { ...appHost, cookie: await sessionCookie('other@example.com') },
  })
  assert.ok(!(otherList.json() as OwnerView[]).some((d) => d.id === drop.id))

  const otherDelete = await app.inject({
    method: 'DELETE',
    url: `/api/uploads/${drop.id}`,
    headers: { ...appHost, cookie: await sessionCookie('other@example.com') },
  })
  assert.equal(otherDelete.statusCode, 404)

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/uploads/${drop.id}`,
    headers: { ...appHost, cookie: await sessionCookie() },
  })
  assert.equal(removed.statusCode, 204)

  const after = await app.inject({
    method: 'GET',
    url: `/api/drops/${drop.id}`,
    headers: appHost,
  })
  assert.equal(after.statusCode, 410)
  assert.equal(keysFor(drop.id).length, 0)
})

test('returns 404 for an unknown link', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/drops/00000000-0000-4000-8000-000000000000',
    headers: appHost,
  })
  assert.equal(res.statusCode, 404)
})

test('refuses a drop the moment it expires, before any sweep runs', async () => {
  const drop = await uploadOk('soon.txt', 'ephemeral')
  db.prepare('UPDATE drops SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, drop.id)

  const meta = await app.inject({ method: 'GET', url: `/api/drops/${drop.id}`, headers: appHost })
  assert.equal(meta.statusCode, 410)

  const file = await app.inject({ method: 'GET', url: `/f/${drop.id}`, headers: contentHost })
  assert.equal(file.statusCode, 410)

  // The bytes are still in storage — expiry is enforced at read time.
  assert.ok(keysFor(drop.id).length > 0)
})

test('the sweeper deletes expired objects and tombstones the row', async () => {
  const drop = await uploadOk('old.txt', 'stale')
  db.prepare('UPDATE drops SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, drop.id)

  const sweeper = startSweeper({ info() {}, error() {} })
  await sweeper.sweep()
  sweeper.stop()

  assert.equal(keysFor(drop.id).length, 0)
  assert.ok(drops.get(drop.id)?.deletedAt)
})

test('serves the SPA for app routes, including deep links', async () => {
  for (const url of ['/', '/login', '/files', '/d/00000000-0000-4000-8000-000000000000']) {
    const res = await app.inject({ method: 'GET', url, headers: appHost })
    assert.equal(res.statusCode, 200, url)
    assert.match(res.headers['content-type'] as string, /text\/html/)
    assert.match(res.body, /<div id="app">/)
  }
})

test('serves the built frontend assets', async () => {
  const index = await app.inject({ method: 'GET', url: '/', headers: appHost })
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(index.body)
  assert.ok(asset, 'index.html should reference a built asset')

  const res = await app.inject({ method: 'GET', url: asset[1], headers: appHost })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'] as string, /javascript/)
})

test('does not serve the SPA on the content host', async () => {
  const res = await app.inject({ method: 'GET', url: '/', headers: contentHost })
  assert.equal(res.statusCode, 404)
})

test('an expired site shows an HTML notice rather than JSON', async () => {
  const drop = await uploadOk('page.html', '<p>hi</p>')
  db.prepare('UPDATE drops SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, drop.id)

  const res = await app.inject({ method: 'GET', url: `/s/${drop.id}/`, headers: contentHost })
  assert.equal(res.statusCode, 410)
  assert.match(res.headers['content-type'] as string, /text\/html/)
  assert.match(res.body, /expired/i)
})

// --- link previews -----------------------------------------------------------

test('an image upload gets a share-card thumbnail', async () => {
  const drop = await uploadOk('photo.png', await samplePng())
  assert.ok(keysFor(drop.id).some((key) => key.endsWith('/preview.jpg')))

  const res = await app.inject({
    method: 'GET',
    url: `/f/${drop.id}/preview`,
    headers: contentHost,
  })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'] as string, /image\/jpeg/)
  // WhatsApp discards anything larger, and a 1600px source must be downscaled.
  assert.ok(res.rawPayload.length < 600 * 1024, 'thumbnail is too large to preview')
})

test('drops without a thumbnail have no preview route', async () => {
  const drop = await uploadOk('notes.txt', 'nothing to see')
  const res = await app.inject({
    method: 'GET',
    url: `/f/${drop.id}/preview`,
    headers: contentHost,
  })
  assert.equal(res.statusCode, 404)
})

test('a bogus image still uploads, just without a thumbnail', async () => {
  const drop = await uploadOk('broken.png', 'this is not a png at all')
  assert.equal(drops.get(drop.id)?.previewWidth, null)
  assert.ok(!keysFor(drop.id).some((key) => key.endsWith('/preview.jpg')))
})

test('a share link carries Open Graph tags for chat previews', async () => {
  const drop = await uploadOk('holiday photo.png', await samplePng())
  const res = await app.inject({ method: 'GET', url: `/d/${drop.id}`, headers: appHost })

  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'] as string, /text\/html/)
  // Still the SPA — the tags are spliced into the same document.
  assert.match(res.body, /<div id="app">/)

  assert.match(res.body, /<meta property="og:title" content="holiday photo.png">/)
  assert.match(res.body, /<meta property="og:description" content="Image · [^"]*expires in 1 hour">/)
  assert.ok(
    res.body.includes(`<meta property="og:image" content="http://content.test/f/${drop.id}/preview">`),
  )
  assert.match(res.body, /<meta property="og:image:width" content="1200">/)
  assert.match(res.body, /<meta property="og:image:height" content="675">/)
  assert.match(res.body, /<meta name="twitter:card" content="summary_large_image">/)
  assert.equal(res.body.match(/<title>/g)?.length, 1, 'exactly one title survives')
})

test('a non-image share link previews as text, with no image', async () => {
  const drop = await uploadOk('report.pdf', '%PDF-1.4 stub')
  const res = await app.inject({ method: 'GET', url: `/d/${drop.id}`, headers: appHost })

  assert.match(res.body, /<meta property="og:title" content="report.pdf">/)
  assert.match(res.body, /<meta name="twitter:card" content="summary">/)
  assert.ok(!res.body.includes('og:image'))
})

test('an expired share link says so instead of previewing the file', async () => {
  const drop = await uploadOk('gone.png', await samplePng())
  db.prepare('UPDATE drops SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, drop.id)

  const res = await app.inject({ method: 'GET', url: `/d/${drop.id}`, headers: appHost })
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /<meta property="og:title" content="Link expired">/)
  assert.ok(!res.body.includes('og:image'))

  const preview = await app.inject({
    method: 'GET',
    url: `/f/${drop.id}/preview`,
    headers: contentHost,
  })
  assert.equal(preview.statusCode, 410)
})

test('share links are not served on the content host', async () => {
  const drop = await uploadOk('photo.png', await samplePng())
  const res = await app.inject({ method: 'GET', url: `/d/${drop.id}`, headers: contentHost })
  assert.equal(res.statusCode, 404)
})

// --- the origin split --------------------------------------------------------
// SPEC.md §7: user content must never be reachable on the app origin, whatever
// shape the request arrives in.

test('percent-encoded content paths do not reach the app origin', async () => {
  const drop = await uploadOk('evil.html', '<script>alert(1)</script>')

  // The router decodes before it matches, so %73 and %66 land on the `/s/` and
  // `/f/` handlers while reading as app paths to a raw prefix check.
  for (const url of [`/%73/${drop.id}/`, `/%66/${drop.id}`, `/%73/${drop.id}/index.html`]) {
    const res = await app.inject({ method: 'GET', url, headers: appHost })
    assert.equal(res.statusCode, 404, `${url} was served on the app host`)
    assert.ok(!res.body.includes('alert(1)'), `${url} leaked user content onto the app origin`)
  }
})

test('an X-Forwarded-Host header cannot move a route to the other origin', async () => {
  const drop = await uploadOk('evil.html', '<script>alert(1)</script>')

  const content = await app.inject({
    method: 'GET',
    url: `/s/${drop.id}/`,
    headers: { ...appHost, 'x-forwarded-host': 'content.test' },
  })
  assert.equal(content.statusCode, 404)
  assert.ok(!content.body.includes('alert(1)'))

  const api = await app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { ...contentHost, 'x-forwarded-host': 'app.test', cookie: await sessionCookie() },
  })
  assert.equal(api.statusCode, 404)
})

test('the host guard holds even when a content route is reached directly', async () => {
  const drop = await uploadOk('page.html', '<p>hi</p>')

  // Same route, both hostnames: only the content host may serve it.
  const onContent = await app.inject({ method: 'GET', url: `/s/${drop.id}/`, headers: contentHost })
  assert.equal(onContent.statusCode, 200)

  const onApp = await app.inject({ method: 'GET', url: `/s/${drop.id}/`, headers: appHost })
  assert.equal(onApp.statusCode, 404)
})

test('a backslash in `next` cannot redirect off-origin', async () => {
  // Browsers normalise `\` to `/` for special schemes, so `/\evil.com` resolves
  // to `//evil.com` — an origin change a `startsWith('//')` check misses.
  for (const next of ['/\\evil.com', '/\\/evil.com', '//evil.com', 'https://evil.com']) {
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/login?next=${encodeURIComponent(next)}`,
      headers: appHost,
    })
    assert.equal(res.statusCode, 302)

    const cookie = decodeURIComponent(String(res.headers['set-cookie']).split(';')[0])
    const pending = JSON.parse(cookie.slice(cookie.indexOf('{'), cookie.lastIndexOf('}') + 1))
    assert.equal(pending.next, '/', `next=${next} survived as ${pending.next}`)
  }
})

test('a relative `next` still round-trips', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/auth/google/login?next=${encodeURIComponent('/files?sort=new#top')}`,
    headers: appHost,
  })

  const cookie = decodeURIComponent(String(res.headers['set-cookie']).split(';')[0])
  const pending = JSON.parse(cookie.slice(cookie.indexOf('{'), cookie.lastIndexOf('}') + 1))
  assert.equal(pending.next, '/files?sort=new#top')
})

// --- limits ------------------------------------------------------------------

test('every route is rate limited, except the health check', async () => {
  const drop = await uploadOk('limits.txt', 'hi')

  // Previously only /api/uploads carried a limit; everything else was open.
  const api = await app.inject({ method: 'GET', url: '/api/config', headers: appHost })
  assert.equal(api.headers['x-ratelimit-limit'], '600')

  // Content routes fan out per asset, so they get their own higher ceiling.
  const content = await app.inject({ method: 'GET', url: `/f/${drop.id}`, headers: contentHost })
  assert.equal(content.headers['x-ratelimit-limit'], '1200')

  // The container health check runs on a fixed interval and must never be cut off.
  const health = await app.inject({ method: 'GET', url: '/health', headers: appHost })
  assert.equal(health.statusCode, 200)
  assert.equal(health.headers['x-ratelimit-limit'], undefined)
})

test('a route over its limit answers 429', async () => {
  // From an address of its own, so the rest of the suite keeps its own budget.
  const from = '203.0.113.55'
  let last = 0

  for (let i = 0; i < 61; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: appHost,
      remoteAddress: from,
    })
    last = res.statusCode
  }

  assert.equal(last, 429, 'the 61st upload in a minute should be refused')
})

test('an oversized Content-Length is refused before the body is read', async () => {
  const { body, contentType } = multipart('big.txt', 'still small')

  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: {
      ...appHost,
      cookie: await sessionCookie(),
      'content-type': contentType,
      'content-length': String(200 * 1024 * 1024),
    },
    payload: body,
  })

  assert.equal(res.statusCode, 413)
  assert.match(res.json().message, /larger than the 10 MB limit/)
})

test('upload buffering is capped by a byte budget, not a request count', async () => {
  let live = 0
  let peak = 0

  // The budget is three times MAX_UPLOAD_BYTES, so five max-size uploads must
  // queue rather than all buffer at once — and all five must still finish.
  const one = () =>
    withUploadBudget(config.maxUploadBytes, async () => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 5))
      live -= 1
    })

  await Promise.all([one(), one(), one(), one(), one()])

  assert.equal(live, 0)
  assert.ok(peak <= 3, `${peak} uploads buffered at once, expected at most 3`)
})

test('zip entries are decompressed on demand', async () => {
  const zip = buildZip([
    { name: 'index.html', data: '<h1>hello</h1>' },
    { name: 'app.js', data: 'console.log(1)' },
    { name: 'style.css', data: 'body{}' },
  ])

  const site = await extractSite(zip)
  try {
    assert.equal(site.entries.length, 3)
    // Readers, not bytes: nothing is held in memory until it is asked for.
    assert.deepEqual(
      site.entries.map((e) => e.path).sort(),
      ['app.js', 'index.html', 'style.css'],
    )
    assert.ok(site.entries.every((e) => typeof e.read === 'function'))

    // Concurrent reads are serialised onto one chain; they must still each
    // return their own entry's bytes.
    const [html, js] = await Promise.all([
      site.entries.find((e) => e.path === 'index.html')!.read(),
      site.entries.find((e) => e.path === 'app.js')!.read(),
    ])
    assert.equal(html.toString(), '<h1>hello</h1>')
    assert.equal(js.toString(), 'console.log(1)')
  } finally {
    site.close()
  }
})
