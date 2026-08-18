import { useState, useRef, useEffect } from 'preact/hooks'

/** Read-only link plus a copy button that confirms itself for a moment. */
export function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => clearTimeout(timer.current ?? undefined), [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Clipboard access needs a secure context; selecting the text is the
      // best fallback available.
      return
    }
    setCopied(true)
    clearTimeout(timer.current ?? undefined)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div class="copy-field">
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" class="button small" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
