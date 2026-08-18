/**
 * The API contract, as seen from the browser.
 *
 * These mirror `OwnerView`, `PublicView` and `DropKind` in
 * `server/src/uploads.ts` and `server/src/types.ts`. They are restated rather
 * than imported so the two workspaces typecheck independently — the server's
 * types pull in Fastify and node typings that the browser build has no use for.
 * Keep them in step when the API changes.
 */

export type DropKind = 'text' | 'markdown' | 'image' | 'audio' | 'pdf' | 'html' | 'site'

/** What the uploader and the dashboard see: includes the shareable link. */
export interface OwnerDrop {
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

/** What an anonymous visitor to a link sees: no owner, but content URLs. */
export interface PublicDrop {
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

export interface TtlChoice {
  label: string
  seconds: number
}

export interface UploadSettings {
  ttlChoices: TtlChoice[]
  defaultTtlSeconds: number
  maxUploadBytes: number
  acceptedExtensions: string[]
}

export interface SessionUser {
  email: string
  name?: string
  picture?: string
}

export interface ApiErrorBody {
  error?: string
  message?: string
}
