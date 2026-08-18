import yauzl from 'yauzl'
import type { Entry, ZipFile } from 'yauzl'
import { config } from './config.ts'

export class ZipError extends Error {
  readonly statusCode = 400

  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** Entries produced by macOS and Windows that nobody wants served. */
const JUNK = [/^__MACOSX\//, /(^|\/)\.DS_Store$/, /(^|\/)Thumbs\.db$/, /(^|\/)desktop\.ini$/i]

const S_IFMT = 0xf000
const S_IFLNK = 0xa000

/** Avoids a regex literal so no control bytes end up in this source file. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & S_IFMT
  return mode === S_IFLNK
}

/**
 * Rejects anything that could escape the drop's prefix once turned into an R2
 * key. Returns the cleaned path, or null if the entry should be skipped.
 * Throws when the path is actively hostile rather than merely uninteresting.
 */
function normaliseEntryPath(name: string): string | null {
  if (name.endsWith('/')) return null // directory record — no bytes to store
  if (JUNK.some((re) => re.test(name))) return null

  if (hasControlChars(name)) throw new ZipError('archive contains a control character in a path')
  if (name.includes('\\')) throw new ZipError(`archive uses backslash paths: ${name}`)
  if (name.startsWith('/')) throw new ZipError(`archive contains an absolute path: ${name}`)
  if (/^[a-zA-Z]:/.test(name)) throw new ZipError(`archive contains a drive-letter path: ${name}`)

  const segments = name.split('/')
  if (segments.some((s) => s === '..')) {
    throw new ZipError(`archive contains a path traversal: ${name}`)
  }

  const cleaned = segments.filter((s) => s !== '' && s !== '.').join('/')
  if (!cleaned) return null
  if (cleaned.length > 400) throw new ZipError(`archive contains an over-long path: ${name}`)
  return cleaned
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) reject(new ZipError(`not a readable zip archive: ${err?.message}`))
      else resolve(zipfile)
    })
  })
}

/**
 * Reads the central directory only. Sizes are known here without decompressing
 * anything, which is what makes the zip-bomb checks meaningful.
 */
function readEntries(zipfile: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = []

    zipfile.on('entry', (entry: Entry) => {
      entries.push(entry)
      if (entries.length > config.maxZipEntries) {
        reject(new ZipError(`archive has more than ${config.maxZipEntries} entries`))
        return
      }
      zipfile.readEntry()
    })
    zipfile.on('end', () => resolve(entries))
    zipfile.on('error', (err: Error) => reject(new ZipError(`could not read archive: ${err.message}`)))
    zipfile.readEntry()
  })
}

function readEntryBuffer(zipfile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(new ZipError(`could not extract ${entry.fileName}: ${err?.message}`))
        return
      }

      const chunks: Buffer[] = []
      let total = 0

      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
        // The central directory already promised a size; a stream that exceeds
        // it means a malformed or malicious archive.
        if (total > entry.uncompressedSize) {
          stream.destroy()
          reject(new ZipError(`${entry.fileName} is larger than its declared size`))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => resolve(Buffer.concat(chunks, total)))
      stream.on('error', (e: Error) =>
        reject(new ZipError(`could not extract ${entry.fileName}: ${e.message}`)),
      )
    })
  })
}

/**
 * Strips wrapper directories so `site.zip` containing `site/index.html` serves
 * as `/`. Collapses repeated single-directory nesting, then falls back to the
 * shallowest index.html if the archive is organised some other way.
 */
function pickRoot(paths: string[]): string {
  let prefix = ''
  let current = paths

  while (current.length > 0) {
    const tops = new Set(current.map((p) => p.split('/')[0]))
    const allNested = current.every((p) => p.includes('/'))
    if (tops.size !== 1 || !allNested) break

    const top = [...tops][0]
    prefix += `${top}/`
    current = current.map((p) => p.slice(top.length + 1))
  }

  if (current.includes('index.html')) return prefix

  const indexes = current
    .filter((p) => p.endsWith('/index.html'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)

  if (indexes.length === 0) {
    throw new ZipError(
      'archive has no index.html — a static site needs one at the root or in a single top-level folder',
    )
  }
  return prefix + indexes[0].slice(0, -'index.html'.length)
}

export interface SiteEntry {
  path: string
  /**
   * Decompresses this entry. Deferred so the caller decides how many entries
   * are in memory at once — an archive may hold MAX_ZIP_TOTAL_BYTES of them.
   */
  read(): Promise<Buffer>
}

export interface ExtractedSite {
  entries: SiteEntry[]
  totalUncompressed: number
  /** Releases the archive. Every `read()` must have settled first. */
  close(): void
}

/**
 * Validates a zip and returns its files as readers, ready for upload. Every
 * limit is checked against the central directory before a single byte is
 * decompressed; the bytes themselves are produced on demand.
 */
export async function extractSite(buffer: Buffer): Promise<ExtractedSite> {
  const zipfile = await openZip(buffer)

  try {
    const entries = await readEntries(zipfile)

    const candidates: Array<{ entry: Entry; path: string }> = []
    let totalUncompressed = 0

    for (const entry of entries) {
      if (isSymlink(entry)) {
        throw new ZipError(`archive contains a symlink: ${entry.fileName}`)
      }
      const cleaned = normaliseEntryPath(entry.fileName)
      if (!cleaned) continue

      totalUncompressed += entry.uncompressedSize
      if (totalUncompressed > config.maxZipTotalBytes) {
        throw new ZipError(
          `archive expands to more than ${Math.floor(config.maxZipTotalBytes / 1024 / 1024)} MB`,
        )
      }
      candidates.push({ entry, path: cleaned })
    }

    if (candidates.length === 0) throw new ZipError('archive is empty')

    const ratio = totalUncompressed / Math.max(buffer.length, 1)
    if (ratio > config.maxZipRatio) {
      throw new ZipError(`archive compression ratio of ${Math.round(ratio)}:1 looks like a zip bomb`)
    }

    const root = pickRoot(candidates.map((c) => c.path))
    const selected = candidates
      .filter((c) => c.path.startsWith(root))
      .map((c) => ({ entry: c.entry, path: c.path.slice(root.length) }))
      .filter((c) => c.path !== '')

    // Reads are serialised onto one chain: concurrent `openReadStream` calls on
    // a single archive are not worth relying on, and one decompression at a
    // time is the point — the caller can still overlap the uploads.
    let chain: Promise<unknown> = Promise.resolve()
    const readInTurn = (entry: Entry): Promise<Buffer> => {
      const next = chain.then(
        () => readEntryBuffer(zipfile, entry),
        () => readEntryBuffer(zipfile, entry),
      )
      chain = next.catch(() => {})
      return next
    }

    return {
      entries: selected.map(({ entry, path }) => ({ path, read: () => readInTurn(entry) })),
      totalUncompressed,
      close: () => zipfile.close(),
    }
  } catch (err) {
    zipfile.close()
    throw err
  }
}
