import crypto from 'node:crypto'
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config.ts'

export interface SessionUser {
  email: string
  name?: string | undefined
  picture?: string | undefined
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated by the auth hook; null for anonymous requests. */
    user: SessionUser | null
  }
}

const SESSION_COOKIE = 'drop_session'
const OAUTH_COOKIE = 'drop_oauth'

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
const sessionKey = new TextEncoder().encode(config.sessionSecret)

const secureCookies = config.appOrigin.startsWith('https://')

/** Host-only (no `domain`), so the session is never sent to CONTENT_ORIGIN. */
const cookieBase = {
  httpOnly: true,
  sameSite: 'lax',
  secure: secureCookies,
  path: '/',
} as const

interface PendingLogin {
  state: string
  verifier: string
  nonce: string
  next: string
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

async function createSession(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${config.sessionTtlSeconds}s`)
    .sign(sessionKey)
}

async function readSession(request: FastifyRequest): Promise<SessionUser | null> {
  const token = request.cookies?.[SESSION_COOKIE]
  if (!token) return null

  try {
    const { payload } = await jwtVerify(token, sessionKey, { algorithms: ['HS256'] })
    const email = typeof payload.email === 'string' ? payload.email : null
    if (!email || !config.allowedEmails.has(email)) return null

    return {
      email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      picture: typeof payload.picture === 'string' ? payload.picture : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Only same-origin paths, so `next` can't be turned into an open redirect.
 *
 * Resolved rather than pattern-matched: browsers normalise backslashes to
 * slashes for special schemes, so `/\evil.com` parses as `//evil.com` and
 * lands on another origin, which a `startsWith('//')` test does not catch.
 */
function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/'

  try {
    const url = new URL(value, config.appOrigin)
    if (url.origin !== config.appOrigin) return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}

interface TokenResponse {
  id_token?: string
}

async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: config.google.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`token exchange failed: ${res.status} ${detail.slice(0, 200)}`)
  }
  return (await res.json()) as TokenResponse
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.decorateRequest('user', null)

  /** Populates `request.user` for every app-origin request. */
  app.addHook('onRequest', async (request) => {
    request.user = await readSession(request)
  })

  app.get<{ Querystring: { next?: string } }>('/auth/google/login', async (request, reply) => {
    const verifier = base64url(crypto.randomBytes(48))
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
    const state = base64url(crypto.randomBytes(24))
    const nonce = base64url(crypto.randomBytes(24))

    const pending: PendingLogin = { state, verifier, nonce, next: safeNext(request.query.next) }
    reply.setCookie(OAUTH_COOKIE, JSON.stringify(pending), {
      ...cookieBase,
      signed: true,
      maxAge: 600,
    })

    const url = new URL(AUTH_ENDPOINT)
    url.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: config.google.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString()

    return reply.redirect(url.toString())
  })

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    async (request, reply) => {
      const fail = (reason: string) => reply.redirect(`/login?error=${encodeURIComponent(reason)}`)

      const raw = request.cookies?.[OAUTH_COOKIE]
      reply.clearCookie(OAUTH_COOKIE, { ...cookieBase })

      if (!raw) return fail('expired')
      const unsigned = request.unsignCookie(raw)
      if (!unsigned.valid || !unsigned.value) return fail('expired')

      let pending: PendingLogin
      try {
        pending = JSON.parse(unsigned.value) as PendingLogin
      } catch {
        return fail('expired')
      }

      if (request.query.error) return fail(String(request.query.error))
      if (!request.query.code || request.query.state !== pending.state) return fail('state')

      let claims
      try {
        const tokens = await exchangeCode(String(request.query.code), pending.verifier)
        if (!tokens.id_token) throw new Error('no id_token in token response')

        const verified = await jwtVerify(tokens.id_token, googleKeys, {
          audience: config.google.clientId,
        })
        claims = verified.payload
      } catch (err) {
        request.log.warn({ err }, 'google sign-in failed')
        return fail('exchange')
      }

      if (!claims.iss || !ISSUERS.includes(claims.iss)) return fail('issuer')
      if (claims.nonce !== pending.nonce) return fail('nonce')
      if (!claims.email || claims.email_verified !== true) return fail('unverified')

      const email = String(claims.email).toLowerCase()
      if (!config.allowedEmails.has(email)) {
        request.log.info({ email }, 'sign-in rejected: not on the allowlist')
        return fail('not-allowed')
      }

      const token = await createSession({
        email,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        picture: typeof claims.picture === 'string' ? claims.picture : undefined,
      })
      reply.setCookie(SESSION_COOKIE, token, { ...cookieBase, maxAge: config.sessionTtlSeconds })

      return reply.redirect(safeNext(pending.next))
    },
  )

  app.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { ...cookieBase })
    return { ok: true }
  })
}

/** preHandler guard for routes that require a signed-in, allowlisted user. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: 'unauthorised', message: 'Sign in to continue.' })
  }
}

/**
 * Rejects cross-site state-changing requests. `SameSite=Lax` already stops the
 * cookie riding along, but this closes the gap for clients that ignore it.
 */
export async function requireSameOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const origin = request.headers.origin
  if (origin && origin !== config.appOrigin) {
    await reply.code(403).send({ error: 'forbidden', message: 'Cross-origin request refused.' })
  }
}
