import type { DropKind } from './types.ts'

const UNITS = ['B', 'KB', 'MB', 'GB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return ''

  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  const rounded = value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)
  return `${rounded} ${UNITS[unit]}`
}

/** Coarse "time left" phrasing: precision below a minute is noise here. */
export function formatRemaining(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now
  if (ms <= 0) return 'expired'

  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return 'under a minute left'
  if (minutes < 60) return `${minutes} min left`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m left` : `${hours}h left`
  }

  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest ? `${days}d ${rest}h left` : `${days}d left`
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export const KIND_LABELS: Record<DropKind, string> = {
  text: 'Text',
  markdown: 'Markdown',
  image: 'Image',
  audio: 'Audio',
  pdf: 'PDF',
  html: 'HTML page',
  site: 'Static site',
}

export function kindLabel(kind: DropKind): string {
  return KIND_LABELS[kind] ?? kind
}

/**
 * A phone or tablet with no mouse: no drag and drop, no keyboard shortcuts.
 * Asks about the primary pointer, so a touchscreen laptop still counts as a desktop.
 */
export function isTouchDevice(): boolean {
  return matchMedia('(pointer: coarse)').matches
}

/** Mac shows ⌘ where the rest show Ctrl; a shortcut hint has to name the real key. */
export function pasteShortcut(): string {
  return /mac|iphone|ipad/i.test(navigator.userAgent) ? '⌘V' : 'Ctrl+V'
}
