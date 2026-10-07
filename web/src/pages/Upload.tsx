import { useEffect, useState } from 'preact/hooks'
import { api } from '../api.ts'
import { Dropzone } from '../components/Dropzone.tsx'
import { CopyField } from '../components/CopyField.tsx'
import type { OwnerDrop, UploadSettings } from '../types.ts'
import { formatBytes, formatDate, isTouchDevice, kindLabel } from '../utils.ts'
import {
  canReadClipboard,
  fileFromClipboard,
  isEditable,
  LinkOnlyError,
  readClipboard,
} from '../clipboard.ts'

const EMPTY_CLIPBOARD = 'There was no file, image, or text in the clipboard.'

/**
 * Turns a synchronous paste event into a file, or the message explaining why
 * there is none. Shared by the window listener and the long-press box.
 */
function pastedFile(event: ClipboardEvent): File | string {
  try {
    return fileFromClipboard(event) ?? EMPTY_CLIPBOARD
  } catch (err) {
    if (err instanceof LinkOnlyError) return err.message
    throw err
  }
}

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

      const file = pastedFile(event)
      if (typeof file === 'string') {
        setError(file)
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

          {isTouchDevice() && !uploading && (
            <TouchPaste
              onFile={(file) => void handleFile(file)}
              onError={setError}
            />
          )}

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

/**
 * Pasting on a phone, where there is no Ctrl+V. The button reads the clipboard
 * directly; when the browser has no Clipboard API or refuses it (the user
 * dismissed the iOS Paste bubble, or denied the Android permission), it gives
 * way to a box the user long-presses to get the system Paste menu.
 *
 * The box is contenteditable rather than a textarea because iOS only hands a
 * pasted image to contenteditable. Being editable, its paste is skipped by the
 * page's window listener, so it handles its own; `inputMode="none"` keeps the
 * keyboard from covering the screen when it is tapped.
 */
function TouchPaste({
  onFile,
  onError,
}: {
  onFile: (file: File) => void
  onError: (message: string) => void
}) {
  const [fallback, setFallback] = useState(!canReadClipboard())

  const pasteFromButton = async () => {
    try {
      const file = await readClipboard()
      if (file) onFile(file)
      else onError(EMPTY_CLIPBOARD)
    } catch (err) {
      if (err instanceof LinkOnlyError) onError(err.message)
      else setFallback(true)
    }
  }

  if (!fallback) {
    return (
      <button type="button" class="button ghost paste-button" onClick={() => void pasteFromButton()}>
        Paste from clipboard
      </button>
    )
  }

  return (
    <div
      class="paste-box"
      contentEditable
      inputMode="none"
      role="textbox"
      aria-label="Paste here"
      data-placeholder="Touch and hold here, then tap Paste"
      onPaste={(event) => {
        event.preventDefault()
        const file = pastedFile(event)
        if (typeof file === 'string') onError(file)
        else onFile(file)
      }}
      // Anything the browser inserts despite preventDefault (or the user types)
      // is not an upload; keep the box empty so the placeholder stays readable.
      onInput={(event) => {
        event.currentTarget.textContent = ''
      }}
    />
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
