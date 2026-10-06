import { useRef, useState, useCallback } from 'preact/hooks'
import type { JSX } from 'preact'
import { isTouchDevice, pasteShortcut } from '../utils.ts'

interface DropzoneProps {
  accept?: string | undefined
  disabled?: boolean
  onFile: (file: File) => void
  hint?: string | undefined
}

export function Dropzone({ accept, disabled = false, onFile, hint }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  // Drag events fire for every child element; a counter avoids flicker.
  const depth = useRef(0)
  const touch = isTouchDevice()

  const pick = useCallback(
    (fileList: FileList | null | undefined) => {
      const file = fileList?.[0]
      if (file) onFile(file)
    },
    [onFile],
  )

  const onDragEnter = (event: JSX.TargetedDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (disabled) return
    depth.current += 1
    setDragging(true)
  }

  const onDragLeave = (event: JSX.TargetedDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }

  const onDrop = (event: JSX.TargetedDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    depth.current = 0
    setDragging(false)
    if (disabled) return
    pick(event.dataTransfer?.files)
  }

  const openPicker = () => {
    if (!disabled) inputRef.current?.click()
  }

  return (
    <div
      class={`dropzone${dragging ? ' dragging' : ''}${disabled ? ' disabled' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openPicker()
        }
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          pick(e.currentTarget.files)
          e.currentTarget.value = ''
        }}
      />

      <div class="dropzone-icon" aria-hidden="true">
        ↓
      </div>
      {touch ? (
        <>
          {/* Phones can neither drag files in nor press Ctrl+V; the Upload
              page puts a Paste button under the dropzone instead. */}
          <p class="dropzone-title">Tap to choose a file</p>
          <p class="dropzone-sub">from your photos, camera, or files</p>
        </>
      ) : (
        <>
          <p class="dropzone-title">{dragging ? 'Release to upload' : 'Drop a file here'}</p>
          {/* The paste itself is handled on the window by the Upload page: a paste
              only reaches the focused element, and this one never demands focus. */}
          <p class="dropzone-sub">or click to browse, or paste with {pasteShortcut()}</p>
        </>
      )}
      {hint && <p class="dropzone-hint">{hint}</p>}
    </div>
  )
}
