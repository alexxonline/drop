import path from 'node:path'

/** Every way a drop can be rendered. Stored verbatim in the `kind` column. */
export type DropKind = 'text' | 'markdown' | 'image' | 'audio' | 'pdf' | 'html' | 'site'

export interface AcceptedType {
  kind: DropKind
  mime: string
}

/**
 * The single source of truth for what may be uploaded. Extension → kind + MIME.
 * Anything absent from this table is rejected with 415; see SPEC.md §3 for the
 * reasoning, including why SVG is not here.
 */
export const ACCEPTED = {
  '.txt': { kind: 'text', mime: 'text/plain; charset=utf-8' },
  '.log': { kind: 'text', mime: 'text/plain; charset=utf-8' },

  '.md': { kind: 'markdown', mime: 'text/markdown; charset=utf-8' },
  '.markdown': { kind: 'markdown', mime: 'text/markdown; charset=utf-8' },

  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },

  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.aac': { kind: 'audio', mime: 'audio/aac' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },

  '.pdf': { kind: 'pdf', mime: 'application/pdf' },

  '.html': { kind: 'html', mime: 'text/html; charset=utf-8' },
  '.htm': { kind: 'html', mime: 'text/html; charset=utf-8' },

  '.zip': { kind: 'site', mime: 'application/zip' },
} as const satisfies Record<string, AcceptedType>

export const ACCEPTED_EXTENSIONS = Object.keys(ACCEPTED)

/** Kinds whose bytes live under `<prefix>site/` and render in an iframe. */
export const SITE_KINDS: ReadonlySet<DropKind> = new Set<DropKind>(['html', 'site'])

export interface Classified extends AcceptedType {
  ext: string
}

export function classify(filename: string): Classified | null {
  const ext = path.extname(String(filename ?? '')).toLowerCase()
  const match = (ACCEPTED as Record<string, AcceptedType | undefined>)[ext]
  if (!match) return null
  return { ext, ...match }
}

/**
 * Content types for files *inside* an uploaded zip. Broader than ACCEPTED —
 * a static site legitimately contains JS, CSS, fonts and SVG. These are only
 * ever served from CONTENT_ORIGIN, where script execution is already expected.
 */
const SITE_ASSET_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
}

export function siteAssetType(entryPath: string): string {
  const ext = path.extname(entryPath).toLowerCase()
  return SITE_ASSET_TYPES[ext] ?? 'application/octet-stream'
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g
const UNSAFE_CHARS = /[^\w.\- ]+/g

/**
 * Makes a user-supplied filename safe to place in an R2 key while keeping it
 * recognisable. Never returns an empty string.
 */
export function sanitiseFilename(filename: string): string {
  const base = path.basename(String(filename ?? '')).normalize('NFC')
  const cleaned = base
    .replace(CONTROL_CHARS, '')
    .replace(UNSAFE_CHARS, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 120)
  return cleaned || 'file'
}
