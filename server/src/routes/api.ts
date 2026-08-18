import type { FastifyInstance } from 'fastify'
import { config, ttlChoices, clampTtl } from '../config.ts'
import { drops } from '../db.ts'
import { requireAuth, requireSameOrigin } from '../auth.ts'
import { storeUpload, destroyDrop, toOwnerView, toPublicView, UploadError } from '../uploads.ts'
import { ACCEPTED_EXTENSIONS } from '../types.ts'

interface IdParams {
  id: string
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  /** Lets the frontend render limits and TTL choices without duplicating them. */
  app.get('/api/config', async () => ({
    ttlChoices,
    defaultTtlSeconds: config.defaultTtlSeconds,
    maxUploadBytes: config.maxUploadBytes,
    acceptedExtensions: ACCEPTED_EXTENSIONS,
  }))

  app.get('/api/me', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthorised' })
    return request.user
  })

  app.post<{ Querystring: { ttl?: string } }>(
    '/api/uploads',
    {
      preHandler: [requireSameOrigin, requireAuth],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const part = await request.file()
      if (!part) throw new UploadError(400, 'No file was included in the request.')

      let buffer: Buffer
      try {
        buffer = await part.toBuffer()
      } catch (err) {
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          throw new UploadError(
            413,
            `That file is larger than the ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB limit.`,
          )
        }
        throw err
      }

      const drop = await storeUpload({
        buffer,
        filename: part.filename,
        // requireAuth guarantees a user by the time the handler runs.
        ownerEmail: request.user!.email,
        ttlSeconds: clampTtl(request.query.ttl ?? config.defaultTtlSeconds),
      })

      request.log.info(
        { id: drop.id, kind: drop.kind, size: drop.size, entries: drop.entryCount },
        'stored drop',
      )
      return reply.code(201).send(toOwnerView(drop))
    },
  )

  app.get('/api/uploads', { preHandler: requireAuth }, async (request) =>
    drops.listByOwner(request.user!.email).map(toOwnerView),
  )

  app.delete<{ Params: IdParams }>(
    '/api/uploads/:id',
    { preHandler: [requireSameOrigin, requireAuth] },
    async (request, reply) => {
      const drop = drops.get(request.params.id)
      if (!drop || drop.deletedAt || drop.ownerEmail !== request.user!.email) {
        // Same response either way, so a signed-in user can't probe for ids.
        return reply.code(404).send({ error: 'not-found' })
      }

      await destroyDrop(drop)
      request.log.info({ id: drop.id }, 'deleted drop')
      return reply.code(204).send()
    },
  )

  app.get<{ Params: IdParams }>('/api/drops/:id', async (request, reply) => {
    const result = drops.resolve(request.params.id)

    if (result.status === 'missing') {
      return reply.code(404).send({ error: 'not-found', message: 'This link does not exist.' })
    }
    if (result.status === 'expired') {
      return reply.code(410).send({
        error: 'expired',
        message: 'This link has expired and the file has been deleted.',
        expiresAt: result.drop.expiresAt,
      })
    }
    return toPublicView(result.drop)
  })
}
