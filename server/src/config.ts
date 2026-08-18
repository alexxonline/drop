import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dotenv from 'dotenv'

const here = path.dirname(fileURLToPath(import.meta.url))
export const rootDir = path.resolve(here, '..', '..')

dotenv.config({ path: path.join(rootDir, '.env'), quiet: true })

const missing: string[] = []

function str(name: string, fallback?: string): string {
  const raw = process.env[name]
  if (raw !== undefined && raw !== '') return raw
  if (fallback !== undefined) return fallback
  missing.push(name)
  return ''
}

function int(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`config: ${name} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return n
}

function origin(name: string, fallback: string): string {
  const raw = str(name, fallback)
  if (!raw) return ''
  try {
    return new URL(raw).origin
  } catch {
    throw new Error(`config: ${name} must be an absolute URL, got ${JSON.stringify(raw)}`)
  }
}

const isProd = process.env.NODE_ENV === 'production'

const maxUploadBytes = int('MAX_UPLOAD_BYTES', 100 * 1024 * 1024)

const appOrigin = origin('APP_ORIGIN', 'http://localhost:5173')
const contentOrigin = origin('CONTENT_ORIGIN', '') || appOrigin

export const config = {
  isProd,
  port: int('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  /**
   * Which peers may set X-Forwarded-For. Trusting every hop (`true`) lets any
   * client claim any IP, which forges the address the rate limiter and the logs
   * work from. The default covers a reverse proxy on the same host and the
   * private ranges Docker publishes ports from, and nothing routable.
   */
  trustProxy: str('TRUST_PROXY', 'loopback, linklocal, uniquelocal'),

  appOrigin,
  contentOrigin,
  /** True when user content shares the app's origin — a dev-only fallback. */
  sharedOrigin: contentOrigin === appOrigin,
  appHost: new URL(appOrigin).host,
  contentHost: new URL(contentOrigin).host,

  sessionSecret: str('SESSION_SECRET'),
  sessionTtlSeconds: 7 * 24 * 60 * 60,

  google: {
    clientId: str('GOOGLE_CLIENT_ID'),
    clientSecret: str('GOOGLE_CLIENT_SECRET'),
    redirectUri: `${appOrigin}/auth/google/callback`,
  },

  allowedEmails: new Set(
    str('ALLOWED_EMAILS', '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  ),

  r2: {
    accountId: str('R2_ACCOUNT_ID'),
    accessKeyId: str('R2_ACCESS_KEY_ID'),
    secretAccessKey: str('R2_SECRET_ACCESS_KEY'),
    bucket: str('R2_BUCKET', 'drop'),
  },

  databasePath: path.resolve(rootDir, str('DATABASE_PATH', './data/drop.db')),
  webDist: path.join(rootDir, 'web', 'dist'),

  maxUploadBytes,
  /**
   * Ceiling on upload bytes held in memory at once. Every upload is buffered
   * whole — the SigV4 payload hash needs the bytes up front — so what bounds
   * RSS is a byte budget, not a request count: ten 200 KB uploads and ten
   * 100 MB ones cost wildly different amounts of memory.
   */
  uploadMemoryBudgetBytes: int('UPLOAD_MEMORY_BUDGET_BYTES', maxUploadBytes * 3),
  defaultTtlSeconds: int('DEFAULT_TTL_SECONDS', 24 * 60 * 60),
  maxTtlSeconds: int('MAX_TTL_SECONDS', 30 * 24 * 60 * 60),
  minTtlSeconds: 60,
  sweepIntervalMs: int('SWEEP_INTERVAL_MS', 60_000),
  /** Requests per minute per IP, before route-level overrides. */
  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 600),
  maxZipEntries: int('MAX_ZIP_ENTRIES', 2000),
  maxZipTotalBytes: int('MAX_ZIP_TOTAL_BYTES', 300 * 1024 * 1024),
  /** Guards against archives that expand catastrophically. */
  maxZipRatio: 200,
  /** Objects written to R2 at once, and so entry buffers alive at once. */
  objectConcurrency: 6,
}

/** Throws with every problem at once, rather than one boot failure at a time. */
export function assertConfig(): void {
  const problems = missing.map((name) => `${name} is required but unset`)

  if (config.sessionSecret && config.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)')
  }
  if (config.allowedEmails.size === 0) {
    problems.push('ALLOWED_EMAILS is empty — nobody would be able to sign in')
  }
  if (config.maxTtlSeconds < config.defaultTtlSeconds) {
    problems.push('MAX_TTL_SECONDS must be >= DEFAULT_TTL_SECONDS')
  }
  if (config.uploadMemoryBudgetBytes < config.maxUploadBytes) {
    problems.push('UPLOAD_MEMORY_BUDGET_BYTES must be >= MAX_UPLOAD_BYTES')
  }
  if (config.isProd && config.sharedOrigin) {
    problems.push(
      'CONTENT_ORIGIN must be set and differ from APP_ORIGIN in production — ' +
        'user-uploaded HTML would otherwise run on the app origin (SPEC.md §7)',
    )
  }

  if (problems.length) {
    throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
  }
}

export interface TtlChoice {
  label: string
  seconds: number
}

/** TTL choices offered in the UI; the server clamps regardless of what arrives. */
export const ttlChoices: TtlChoice[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '6 hours', seconds: 21600 },
  { label: '24 hours', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: '30 days', seconds: 2592000 },
].filter((c) => c.seconds <= config.maxTtlSeconds)

export function clampTtl(seconds: unknown): number {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n <= 0) return config.defaultTtlSeconds
  return Math.min(Math.max(Math.floor(n), config.minTtlSeconds), config.maxTtlSeconds)
}
