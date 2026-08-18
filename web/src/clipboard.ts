/**
 * Turning a paste into an uploadable file.
 *
 * Ctrl/Cmd+V gives us one of three things: a real file copied in the OS file
 * manager, a bitmap (a screenshot, or an image copied from a page), or plain
 * text. The first two arrive in `clipboardData.files` and already are `File`s;
 * text has to be wrapped in one, since the API only speaks multipart uploads.
 */

/** Browsers name every pasted bitmap this, so it says nothing about the file. */
const GENERIC_NAME = /^(image|blob)(\.\w+)?$/i

/** Fallbacks for clipboard files whose own name carries no usable extension. */
const EXTENSION_FOR_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/pdf': '.pdf',
}

/** `pasted-20260818-1432` — sorts chronologically and never collides in a session. */
function stamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `pasted-${date}-${time}`
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * A copied file keeps its own name — that name is the one thing the recipient
 * will see. Only a bitmap, which the browser hands over as a bare `image.png`,
 * is renamed, so a page full of uploads stays tellable apart.
 */
function named(file: File): File {
  const original = file.name ?? ''
  if (original && !GENERIC_NAME.test(original)) return file

  const ext = extensionOf(original) || EXTENSION_FOR_MIME[file.type.split(';')[0]!] || ''
  return new File([file], `${stamp()}${ext}`, { type: file.type })
}

/**
 * The file a paste is offering, or `null` when the clipboard holds nothing we
 * can upload. Rejection is left to the server's extension table: this decides
 * *what* was pasted, not whether it is allowed.
 */
export function fileFromClipboard(event: ClipboardEvent): File | null {
  const data = event.clipboardData
  if (!data) return null

  const file = data.files?.[0]
  if (file && file.size > 0) return named(file)

  const text = data.getData('text/plain')
  if (!text.trim()) return null

  return new File([text], `${stamp()}.txt`, { type: 'text/plain' })
}

/**
 * Whether the paste belongs to something the user is typing in. Hijacking a
 * paste into a real field would break the field for no gain.
 */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}
