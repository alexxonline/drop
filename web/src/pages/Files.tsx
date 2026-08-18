import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { CopyField } from '../components/CopyField.tsx'
import type { OwnerDrop } from '../types.ts'
import { formatBytes, formatDate, formatRemaining, kindLabel } from '../utils.ts'

export function Files() {
  const [drops, setDrops] = useState<OwnerDrop[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    api
      .listUploads()
      .then(setDrops)
      .catch((err: Error) => setError(err.message))
  }, [])

  // Keeps the countdowns honest without re-fetching.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const remove = async (drop: OwnerDrop) => {
    if (!confirm(`Delete "${drop.filename}" now? The link stops working immediately.`)) return

    setBusy(drop.id)
    try {
      await api.deleteUpload(drop.id)
      setDrops((current) => (current ?? []).filter((d) => d.id !== drop.id))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (error) return <p class="alert">{error}</p>
  if (!drops) return <div class="page-loading">Loading…</div>

  return (
    <div class="stack">
      <div class="page-head">
        <h1>Your files</h1>
        <p class="muted">Everything you have uploaded that has not expired yet.</p>
      </div>

      {drops.length === 0 ? (
        <div class="empty">
          <p>Nothing here yet.</p>
          <a class="button" href="/">
            Upload a file
          </a>
        </div>
      ) : (
        <ul class="file-list">
          {drops.map((drop) => (
            <li key={drop.id} class="card file-row">
              <div class="file-row-head">
                <span class="badge">{kindLabel(drop.kind)}</span>
                <strong class="ellipsis">{drop.filename}</strong>
                <span class="muted small nowrap" title={formatDate(drop.expiresAt)}>
                  {formatRemaining(drop.expiresAt, now)}
                </span>
              </div>

              <CopyField value={drop.url} />

              <div class="row space-between">
                <span class="muted small">
                  {formatBytes(drop.size)}
                  {drop.entryCount > 1 ? ` · ${drop.entryCount} files` : ''}
                </span>
                <span class="row">
                  <a class="button small ghost" href={drop.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <button
                    type="button"
                    class="button small danger"
                    disabled={busy === drop.id}
                    onClick={() => void remove(drop)}
                  >
                    {busy === drop.id ? 'Deleting…' : 'Delete'}
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
