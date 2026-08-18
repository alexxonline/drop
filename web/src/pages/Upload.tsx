import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { CopyField } from '../components/CopyField.tsx'
import type { OwnerDrop, UploadSettings } from '../types.ts'
import { formatBytes, formatDate, kindLabel } from '../utils.ts'
import { fileFromClipboard, isEditable } from '../clipboard.ts'

export function Upload() {
  const [settings, setSettings] = useState<UploadSettings | null>(null)
  const [ttl, setTtl] = useState<number | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<OwnerDrop | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .config()
      .then((cfg) => {
        setSettings(cfg)
        setTtl(cfg.defaultTtlSeconds)
      })
      .catch(() => setError('Could not load upload settings.'))
  }, [])

  const uploading = progress !== null

  const handleFile = async (file: File) => {
    if (settings && file.size > settings.maxUploadBytes) {
      setError(
        `That file is ${formatBytes(file.size)} — the limit is ${formatBytes(settings.maxUploadBytes)}.`,
      )
      return
    }

    setError(null)
    setResult(null)
    setProgress(0)

    try {
      const drop = await api.upload(file, ttl ?? settings!.defaultTtlSeconds, setProgress)
      setResult(drop)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setProgress(null)
    }
  }

  /**
   * Ctrl/Cmd+V anywhere on the page uploads whatever is in the clipboard. The
   * listener sits on the window rather than the dropzone because a paste only
   * reaches an element that holds focus, and nothing here asks for focus first.
   * It is bound exactly while the dropzone is on screen, so the shortcut is
   * live only when the UI is offering an upload.
   *
   * No dependency list on purpose: the handler closes over the selected TTL, and
   * rebinding one listener per render costs less than a stale-closure bug.
   */
  useEffect(() => {
    if (!settings || uploading || result) return

    const onPaste = (event: ClipboardEvent) => {
      if (isEditable(event.target)) return

      const file = fileFromClipboard(event)
      if (!file) {
        setError('There was no file, image, or text in the clipboard.')
        return
      }

      event.preventDefault()
      void handleFile(file)
    }

    addEventListener('paste', onPaste)
    return () => removeEventListener('paste', onPaste)
  })

  if (!settings && !error) return <div class="page-loading">Loading…</div>

  return (
    <div class="stack">
      <div class="page-head">
        <h1>Upload</h1>
        <p class="muted">
          The link works for anyone, with no sign-in, until it expires. Then the file is deleted
          from storage.
        </p>
      </div>

      {error && <p class="alert">{error}</p>}

      {result ? (
        <Result drop={result} onReset={() => setResult(null)} />
      ) : (
        <>
          <Dropzone
            accept={settings?.acceptedExtensions.join(',')}
            disabled={uploading}
            onFile={(file) => void handleFile(file)}
            hint={
              settings
                ? `Up to ${formatBytes(settings.maxUploadBytes)} · ${settings.acceptedExtensions
                    .join(' ')
                    .replaceAll('.', '')}`
                : undefined
            }
          />

          {uploading ? (
            <div class="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <div class="progress-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              <span class="progress-label">
                {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Processing…'}
              </span>
            </div>
          ) : (
            <label class="field">
              <span>Expires after</span>
              <select
                value={ttl ?? undefined}
                onChange={(e) => setTtl(Number(e.currentTarget.value))}
              >
                {settings?.ttlChoices.map((choice) => (
                  <option key={choice.seconds} value={choice.seconds}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
    </div>
  )
}

function Result({ drop, onReset }: { drop: OwnerDrop; onReset: () => void }) {
  return (
    <div class="card result">
      <div class="result-head">
        <span class="badge">{kindLabel(drop.kind)}</span>
        <strong class="ellipsis">{drop.filename}</strong>
      </div>

      <CopyField value={drop.url} />

      <dl class="meta">
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(drop.size)}</dd>
        </div>
        {drop.entryCount > 1 && (
          <div>
            <dt>Files</dt>
            <dd>{drop.entryCount}</dd>
          </div>
        )}
        <div>
          <dt>Expires</dt>
          <dd>{formatDate(drop.expiresAt)}</dd>
        </div>
      </dl>

      <div class="row">
        <a class="button" href={drop.url} target="_blank" rel="noreferrer">
          Open link
        </a>
        <button type="button" class="button ghost" onClick={onReset}>
          Upload another
        </button>
      </div>
    </div>
  )
}
