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
 * Thrown when the clipboard holds only a link to an image, which is what
 * Safari hands a web page for a picture copied off another site. The bytes are
 * on the clipboard for native apps, but WebKit does not expose them to us.
 */
export class LinkOnlyError extends Error {
  constructor() {
    super(
      'Safari only shared a link to that image, not the image itself. Long-press the image, ' +
        'choose Save to Photos, then tap the upload box and pick it from your photos.',
    )
  }
}

/** First URI of a `text/uri-list`: one per line, `#` lines are comments. */
function firstUri(list: string): string {
  return list.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? ''
}

/**
 * Google's results grid embeds thumbnails as `data:` URLs, so a "link" copied
 * from it already carries the whole image and can be decoded right here.
 */
function fileFromDataUrl(url: string): File | null {
  const match = /^data:(image\/[\w.+-]+)((?:;[^;,]*)*),(.*)$/is.exec(url)
  if (!match) return null
  const [, type, params, payload] = match as unknown as [string, string, string, string]

  try {
    const bytes = /;base64/i.test(params)
      ? Uint8Array.from(atob(payload.replace(/\s/g, '')), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(payload))
    return named(new File([bytes], '', { type: type.toLowerCase() }))
  } catch {
    return null
  }
}

/**
 * What a paste resolves to, whichever API it came through: a real file or
 * image first, then an image inlined in a `data:` link, then plain text. A
 * bare web link with nothing else is not uploadable, and says so.
 */
function resolve(image: File | null, uriList: string, text: string): File | null {
  if (image && image.size > 0) return named(image)

  const uri = firstUri(uriList)
  const inlined = uri ? fileFromDataUrl(uri) : null
  if (inlined) return inlined

  if (text.trim()) return new File([text], `${stamp()}.txt`, { type: 'text/plain' })

  if (/^https?:/i.test(uri)) throw new LinkOnlyError()
  return null
}

/**
 * The file a paste is offering, or `null` when the clipboard holds nothing we
 * can upload; throws `LinkOnlyError` for a bare image link. Rejection is left
 * to the server's extension table: this decides *what* was pasted, not whether
 * it is allowed.
 */
export function fileFromClipboard(event: ClipboardEvent): File | null {
  const data = event.clipboardData
  if (!data) return null
  return resolve(data.files?.[0] ?? null, data.getData('text/uri-list'), data.getData('text/plain'))
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

/**
 * Whether the async Clipboard API can hand us more than text. Phones have no
 * Ctrl+V, so this is how a tap on a button reaches the clipboard at all.
 */
export function canReadClipboard(): boolean {
  return typeof navigator.clipboard?.read === 'function'
}

/**
 * Reads the clipboard on request, for a tap on the "Paste" button. iOS shows
 * its own confirm bubble and Android asks for permission once, so this must
 * run straight from the user's gesture. Throws `LinkOnlyError` for a bare image
 * link; any other throw means the browser refused, and the caller falls back
 * to a box the user long-presses to paste into.
 *
 * An image beats text when an item offers both (a copied picture often carries
 * its URL as text too). HTML is skipped: its plain-text twin is what people mean.
 */
export async function readClipboard(): Promise<File | null> {
  const items = await navigator.clipboard.read()

  const read = async (type: string) => {
    const item = items.find((candidate) => candidate.types.includes(type))
    return item ? await (await item.getType(type)).text() : ''
  }

  let image: File | null = null
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.startsWith('image/'))
    if (!type) continue
    const blob = await item.getType(type)
    image = new File([blob], '', { type: blob.type || type })
    break
  }

  return resolve(image, await read('text/uri-list'), await read('text/plain'))
}
