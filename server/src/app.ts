import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import type { FastifyError, FastifyInstance } from 'fastify'
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

/** Paths that belong to CONTENT_ORIGIN rather than the app. */
function isContentPath(url: string): boolean {
  return url.startsWith('/f/') || url.startsWith('/s/') || url === '/s'
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
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  })

  await app.register(cookie, { secret: config.sessionSecret })
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, parts: 10 },
  })
  await app.register(rateLimit, {
    global: false,
    max: 600,
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

      const onContentHost = request.host === config.contentHost
      const wantsContent = isContentPath(request.url)

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
    if (isContentPath(request.url)) return
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

  app.get('/health', async () => ({ ok: true }))

  // Auth and API share one encapsulated context so the session hook runs for
  // them and not for content requests.
  await app.register(async (scope) => {
    await authRoutes(scope)
    await apiRoutes(scope)
  })

  await app.register(contentRoutes)

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
    const isAppHost = config.sharedOrigin || request.host === config.appHost
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
