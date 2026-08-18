import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { config } from './config.ts'
import { authRoutes } from './auth.ts'
import { apiRoutes } from './routes/api.ts'
import { contentRoutes } from './routes/content.ts'
import { shareRoutes } from './routes/share.ts'
import { UploadError } from './uploads.ts'
import { ZipError } from './zip.ts'

/** Route patterns served from CONTENT_ORIGIN. Kept in step with routes/content.ts. */
const CONTENT_ROUTES: ReadonlySet<string> = new Set([
  '/f/:id',
  '/f/:id/preview',
  '/s/:id',
  '/s/:id/*',
])

/**
 * Paths that belong to CONTENT_ORIGIN rather than the app.
 *
 * Matched against the *decoded* path, because the router decodes before it
 * matches: `/%73/<id>/` reaches the `/s/:id/*` handler while a raw prefix check
 * on `request.url` reads it as an app path. A path that will not decode counts
 * as content, so a malformed URL fails towards refusing to serve it here.
 */
function isContentPath(url: string): boolean {
  const raw = url.split(/[?#]/)[0]

  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    return true
  }
  return path.startsWith('/f/') || path.startsWith('/s/') || path === '/s'
}

/**
 * Whether a request targets user content. Prefers the pattern the router
 * actually matched — no encoding trick survives that — and falls back to the
 * path for requests that matched no route at all.
 */
function isContentRequest(request: FastifyRequest): boolean {
  const pattern = request.routeOptions?.url
  if (pattern !== undefined) return CONTENT_ROUTES.has(pattern)
  return isContentPath(request.url)
}

/**
 * Refuses a whole family of routes on the wrong hostname. Bound to the routes
 * themselves rather than to a URL prefix, so the boundary holds even if the
 * classifier above is ever fooled again, and a route added later inherits it.
 *
 * `request.headers.host`, deliberately, not `request.host`: with `trustProxy`
 * on, the latter prefers `X-Forwarded-Host`, and a reverse proxy will forward a
 * client-supplied one untouched. The Host header is what the proxy matched its
 * own site block on.
 */
function hostGuard(expected: string) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (config.sharedOrigin) return
    if ((request.headers.host ?? '') !== expected) {
      await reply.code(404).send({ error: 'not-found' })
    }
  }
}

function contentSecurityPolicy(): string {
  const content = config.sharedOrigin ? "'self'" : `'self' ${config.contentOrigin}`
  const scriptSrc = config.isProd ? "'self'" : "'self' 'unsafe-inline' 'unsafe-eval'"
  const connectSrc = config.isProd
    ? `'self' ${config.contentOrigin}`
    : `'self' ${config.contentOrigin} ws:`

  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src 'self' data: blob: ${content}`,
    `media-src 'self' blob: ${content}`,
    `frame-src ${content}`,
    `connect-src ${connectSrc}`,
  ].join('; ')
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: config.isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  })

  await app.register(cookie, { secret: config.sessionSecret })
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, parts: 10 },
  })
  // On by default rather than opt-in: every unlisted route was unlimited, and
  // the content routes each turn into an R2 round-trip. Routes that legitimately
  // burst raise their own ceiling; see routes/content.ts.
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimitPerMinute,
    timeWindow: '1 minute',
    hook: 'onRequest',
  })

  /**
   * Keeps the two hostnames strictly separate: user content is unreachable on
   * the app origin, and the app's API is unreachable from user content. This is
   * the boundary the whole security model rests on — see SPEC.md §7.
   */
  if (!config.sharedOrigin) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/health') return

      const onContentHost = request.headers.host === config.contentHost
      const wantsContent = isContentRequest(request)

      if (onContentHost !== wantsContent) {
        await reply.code(404).send({ error: 'not-found' })
      }
    })
  } else {
    app.log.warn(
      'CONTENT_ORIGIN is unset: user-uploaded HTML will be served from the app origin. ' +
        'Acceptable for local development only.',
    )
  }

  const csp = contentSecurityPolicy()
  app.addHook('onRequest', async (request, reply) => {
    if (isContentRequest(request)) return
    reply.headers({
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-frame-options': 'DENY',
    })
  })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500

    if (
      error instanceof UploadError ||
      error instanceof ZipError ||
      (status >= 400 && status < 500)
    ) {
      request.log.info({ err: error, url: request.url }, 'request rejected')
      return reply.code(status).send({ error: error.code || 'bad-request', message: error.message })
    }

    request.log.error({ err: error, url: request.url }, 'request failed')
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong.' })
  })

  // Unlimited: the container's own health check calls it on a fixed interval.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }))

  // Auth and API share one encapsulated context so the session hook runs for
  // them and not for content requests.
  await app.register(async (scope) => {
    scope.addHook('onRequest', hostGuard(config.appHost))
    await authRoutes(scope)
    await apiRoutes(scope)
  })

  await app.register(async (scope) => {
    scope.addHook('onRequest', hostGuard(config.contentHost))
    await contentRoutes(scope)
  })

  const indexPath = path.join(config.webDist, 'index.html')
  const hasBuild = fs.existsSync(indexPath)
  if (hasBuild) {
    await app.register(fastifyStatic, { root: config.webDist, index: false, wildcard: false })
    // Share links get the same document with Open Graph tags spliced in, so
    // pasting one into a chat app shows the file rather than a bare URL.
    await app.register(shareRoutes, { indexHtml: fs.readFileSync(indexPath, 'utf8') })
  } else {
    app.log.warn('web/dist not found — run "npm run build". Use the Vite dev server meanwhile.')
  }

  app.setNotFoundHandler(async (request, reply) => {
    const isAppHost = config.sharedOrigin || request.headers.host === config.appHost
    const isPage =
      request.method === 'GET' &&
      !request.url.startsWith('/api/') &&
      !request.url.startsWith('/auth/') &&
      !isContentPath(request.url)

    if (hasBuild && isAppHost && isPage) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html')
    }
    return reply.code(404).send({ error: 'not-found' })
  })

  return app
}
