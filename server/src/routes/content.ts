import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { config } from '../config.ts'
import { drops } from '../db.ts'
import { escapeHtml } from '../html.ts'
import { previewKey, PREVIEW_MIME } from '../preview.ts'
import { getObject } from '../r2.ts'
import { SITE_KINDS } from '../types.ts'

/** Headers worth passing through from R2 to the browser verbatim. */
const PASSTHROUGH = ['content-length', 'etag', 'last-modified', 'content-range', 'accept-ranges']

/**
 * Standalone page for content-origin errors. A browser renders these directly,
 * so JSON would be unhelpful — and the app's SPA does not exist on this host.
 */
function statusPage(
  reply: FastifyReply,
  code: number,
  title: string,
  detail: string,
): FastifyReply {
  return reply
    .code(code)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      `<!doctype html><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title>` +
        `<style>` +
        `html{color-scheme:dark light}` +
        `body{min-height:100vh;margin:0;display:grid;place-items:center;` +
        `font:16px/1.6 ui-sans-serif,system-ui,sans-serif;background:#0d0f13;color:#e6e8ee}` +
        `main{max-width:32rem;padding:2rem;text-align:center}` +
        `h1{font-size:1.25rem;margin:0 0 .5rem}` +
        `p{margin:0;color:#9aa3b2}` +
        `</style>` +
        `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>`,
    )
}

interface RelayOptions {
  contentType: string
  cacheControl: string
}

/** Streams an R2 response through Fastify, preserving range semantics. */
function relay(reply: FastifyReply, res: Response, options: RelayOptions): FastifyReply {
  for (const header of PASSTHROUGH) {
    const value = res.headers.get(header)
    if (value) reply.header(header, value)
  }

  reply
    .code(res.status === 206 ? 206 : 200)
    .header('accept-ranges', res.headers.get('accept-ranges') ?? 'bytes')
    .header('cache-control', options.cacheControl)
    .header('x-content-type-options', 'nosniff')
    .type(options.contentType)

  return reply.send(res.body ? Readable.fromWeb(res.body) : null)
}

interface IdParams {
  id: string
}

interface SiteParams extends IdParams {
  '*': string
}

export async function contentRoutes(app: FastifyInstance): Promise<void> {
  /** Raw bytes: images, audio, PDFs, text, and downloads of any kind. */
  app.get<{ Params: IdParams; Querystring: { download?: string } }>(
    '/f/:id',
    async (request, reply) => {
      const result = drops.resolve(request.params.id)

      if (result.status === 'missing') {
        return reply.code(404).send({ error: 'not-found' })
      }
      if (result.status === 'expired') {
        return reply.code(410).send({ error: 'expired' })
      }

      const drop = result.drop
      const res = await getObject(drop.objectKey, { range: request.headers.range })
      if (!res) return reply.code(404).send({ error: 'not-found' })

      const download = request.query.download === '1'
      const disposition = download ? 'attachment' : 'inline'

      reply
        // The viewer page lives on APP_ORIGIN and fetches text and markdown here.
        .header('access-control-allow-origin', config.appOrigin)
        .header('vary', 'origin')
        // Without this, images and audio from the content host are blocked when
        // embedded by the app page.
        .header('cross-origin-resource-policy', 'cross-origin')
        .header(
          'content-disposition',
          `${disposition}; filename*=UTF-8''${encodeURIComponent(drop.filename)}`,
        )

      return relay(reply, res, {
        contentType: download ? 'application/octet-stream' : drop.mime,
        cacheControl: 'public, max-age=300',
      })
    },
  )

  /**
   * The share-card thumbnail. Chat and social crawlers fetch this URL from
   * `og:image`, so it stays small and always JPEG — see preview.ts.
   */
  app.get<{ Params: IdParams }>('/f/:id/preview', async (request, reply) => {
    const result = drops.resolve(request.params.id)

    if (result.status === 'missing') {
      return reply.code(404).send({ error: 'not-found' })
    }
    if (result.status === 'expired') {
      return reply.code(410).send({ error: 'expired' })
    }
    if (!result.drop.previewWidth) {
      return reply.code(404).send({ error: 'not-found' })
    }

    const res = await getObject(previewKey(result.drop.prefix))
    if (!res) return reply.code(404).send({ error: 'not-found' })

    reply.header('cross-origin-resource-policy', 'cross-origin')

    return relay(reply, res, { contentType: PREVIEW_MIME, cacheControl: 'public, max-age=300' })
  })

  // Relative links inside a site only resolve correctly from a trailing slash.
  app.get<{ Params: IdParams }>('/s/:id', async (request, reply) =>
    reply.redirect(`/s/${request.params.id}/`, 301),
  )

  /** Static site assets for `html` and `site` drops. */
  app.get<{ Params: SiteParams }>('/s/:id/*', async (request, reply) => {
    const result = drops.resolve(request.params.id)

    if (result.status === 'missing') {
      return statusPage(reply, 404, 'Not found', 'This link does not exist.')
    }
    if (result.status === 'expired') {
      return statusPage(
        reply,
        410,
        'Link expired',
        'This upload reached its expiry time and has been deleted.',
      )
    }

    const drop = result.drop
    if (!SITE_KINDS.has(drop.kind)) {
      return statusPage(reply, 404, 'Not found', 'This link is not a site.')
    }

    const requested = request.params['*'] || ''
    if (requested.split('/').includes('..')) {
      return statusPage(reply, 400, 'Bad request', 'That path is not allowed.')
    }

    const base = `${drop.prefix}site/`
    const relative =
      requested === '' || requested.endsWith('/') ? `${requested}index.html` : requested

    let res = await getObject(base + relative)
    if (!res && !requested.endsWith('/') && requested !== '') {
      // Directory-style URL without the trailing slash.
      res = await getObject(`${base + requested}/index.html`)
    }
    if (!res) {
      return statusPage(reply, 404, 'Not found', 'That page is not part of this upload.')
    }

    // Embeddable by the viewer's top bar, but not by arbitrary third parties.
    reply.header('content-security-policy', `frame-ancestors 'self' ${config.appOrigin}`)

    return relay(reply, res, {
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      cacheControl: 'public, max-age=300',
    })
  })
}
