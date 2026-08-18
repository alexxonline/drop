import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.ts'
import type { DropKind } from './types.ts'

/** Rows are retained this long after deletion so expired links can say so. */
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000

/** A stored upload, in application casing. */
export interface Drop {
  id: string
  ownerEmail: string
  filename: string
  kind: DropKind
  mime: string
  size: number
  /** Single-file kinds point at their object; `html` and `site` at the index. */
  objectKey: string
  /** `drops/<id>/` — everything under here belongs to this drop. */
  prefix: string
  entryCount: number
  /** Share-card thumbnail size, or null when the drop has no preview image. */
  previewWidth: number | null
  previewHeight: number | null
  createdAt: number
  expiresAt: number
  deletedAt: number | null
}

/** What `create` accepts: the row before it has ever been deleted. */
export type NewDrop = Omit<Drop, 'deletedAt'>

/** Result of a public lookup — "gone" and "never existed" are different answers. */
export type Resolution =
  | { status: 'missing' }
  | { status: 'expired'; drop: Drop }
  | { status: 'ok'; drop: Drop }

interface DropRow {
  id: string
  owner_email: string
  filename: string
  kind: string
  mime: string
  size: number
  object_key: string
  prefix: string
  entry_count: number
  preview_width: number | null
  preview_height: number | null
  created_at: number
  expires_at: number
  deleted_at: number | null
}

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })

const db = new Database(config.databasePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('busy_timeout = 5000')

db.exec(`
  CREATE TABLE IF NOT EXISTS drops (
    id           TEXT PRIMARY KEY,
    owner_email  TEXT NOT NULL,
    filename     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    mime         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    object_key   TEXT,
    prefix       TEXT NOT NULL,
    entry_count  INTEGER NOT NULL DEFAULT 1,
    preview_width  INTEGER,
    preview_height INTEGER,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    deleted_at   INTEGER
  );

  CREATE INDEX IF NOT EXISTS drops_expiry
    ON drops (expires_at) WHERE deleted_at IS NULL;

  CREATE INDEX IF NOT EXISTS drops_owner
    ON drops (owner_email, created_at DESC);
`)

/** Columns added after the first release; older databases predate them. */
const existing = new Set(
  db
    .prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?)')
    .all('drops')
    .map((column) => column.name),
)
for (const column of ['preview_width', 'preview_height']) {
  if (!existing.has(column)) db.exec(`ALTER TABLE drops ADD COLUMN ${column} INTEGER`)
}

const statements = {
  insert: db.prepare<[NewDrop]>(`
    INSERT INTO drops (id, owner_email, filename, kind, mime, size,
                       object_key, prefix, entry_count, preview_width, preview_height,
                       created_at, expires_at)
    VALUES (@id, @ownerEmail, @filename, @kind, @mime, @size,
            @objectKey, @prefix, @entryCount, @previewWidth, @previewHeight,
            @createdAt, @expiresAt)
  `),
  byId: db.prepare<[string], DropRow>('SELECT * FROM drops WHERE id = ?'),
  listByOwner: db.prepare<[string, number], DropRow>(`
    SELECT * FROM drops
    WHERE owner_email = ? AND deleted_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 200
  `),
  listExpired: db.prepare<[number, number], DropRow>(`
    SELECT * FROM drops
    WHERE deleted_at IS NULL AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `),
  markDeleted: db.prepare<[number, string]>(
    'UPDATE drops SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL',
  ),
  purgeTombstones: db.prepare<[number]>(
    'DELETE FROM drops WHERE deleted_at IS NOT NULL AND deleted_at <= ?',
  ),
}

function toDrop(row: DropRow): Drop {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    filename: row.filename,
    kind: row.kind as DropKind,
    mime: row.mime,
    size: row.size,
    objectKey: row.object_key,
    prefix: row.prefix,
    entryCount: row.entry_count,
    previewWidth: row.preview_width,
    previewHeight: row.preview_height,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
  }
}

export const drops = {
  create(drop: NewDrop): NewDrop {
    statements.insert.run(drop)
    return drop
  },

  get(id: string): Drop | null {
    const row = statements.byId.get(id)
    return row ? toDrop(row) : null
  },

  resolve(id: string, now = Date.now()): Resolution {
    const row = statements.byId.get(id)
    if (!row) return { status: 'missing' }

    const drop = toDrop(row)
    if (drop.deletedAt || drop.expiresAt <= now) return { status: 'expired', drop }
    return { status: 'ok', drop }
  },

  listByOwner(email: string, now = Date.now()): Drop[] {
    return statements.listByOwner.all(email, now).map(toDrop)
  },

  listExpired(now = Date.now(), limit = 100): Drop[] {
    return statements.listExpired.all(now, limit).map(toDrop)
  },

  markDeleted(id: string, now = Date.now()): boolean {
    return statements.markDeleted.run(now, id).changes > 0
  },

  purgeTombstones(now = Date.now()): number {
    return statements.purgeTombstones.run(now - TOMBSTONE_MS).changes
  },
}

export function closeDatabase(): void {
  db.close()
}

export default db
