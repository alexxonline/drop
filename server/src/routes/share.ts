import type { FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import { drops } from '../db.ts'
import type { Drop } from '../db.ts'
import { escapeHtml } from '../html.ts'
import type { DropKind } from '../types.ts'

/**
 * Share links are the SPA, and chat apps do not run JavaScript: WhatsApp,
 * Signal, Slack, iMessage and the rest fetch the URL once, read the <head>,
 * and render whatever Open Graph tags they find. So `/d/:id` is served here
 * instead of by the catch-all — same document, with the drop's own title,
 * description and thumbnail baked into the markup before it goes out.
 */

const KIND_LABELS: Record<DropKind, string> = {
  text: 'Text file',
  markdown: 'Markdown',
  image: 'Image',
  audio: 'Audio',
  pdf: 'PDF',
  html: 'HTML page',
  site: 'Static site',
}

const UNITS = ['B', 'KB', 'MB', 'GB']

function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)
  return `${rounded} ${UNITS[unit]}`
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Relative rather than absolute, because a crawler fetches this page at the
 * moment the link is pasted — which is exactly when "in 23 hours" is true.
 */
function formatRemaining(expiresAt: number, now: number): string {
  const minutes = Math.round((expiresAt - now) / 60_000)
  if (minutes < 60) return `in ${plural(Math.max(minutes, 1), 'minute')}`

  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${plural(hours, 'hour')}`
  return `in ${plural(Math.round(hours / 24), 'day')}`
}

interface Card {
  title: string
  description: string
  image: { url: string; width: number; height: number; alt: string } | null
}

function cardFor(id: string, now: number): Card {
  const result = drops.resolve(id, now)

  if (result.status === 'missing') {
    return { title: 'Link not found', description: 'This link does not exist.', image: null }
  }
  if (result.status === 'expired') {
    return {
      title: 'Link expired',
      description: 'This upload reached its expiry time and has been deleted.',
      image: null,
    }
  }

  const drop: Drop = result.drop
  const parts = [KIND_LABELS[drop.kind], formatBytes(drop.size)]
  if (drop.kind === 'site') parts.push(plural(drop.entryCount, 'file'))
  parts.push(`expires ${formatRemaining(drop.expiresAt, now)}`)

  return {
    title: drop.filename,
    description: parts.join(' · '),
    image:
      drop.previewWidth && drop.previewHeight
        ? {
            url: `${config.contentOrigin}/f/${drop.id}/preview`,
            width: drop.previewWidth,
            height: drop.previewHeight,
            alt: drop.filename,
          }
        : null,
  }
}

function renderHead(id: string, card: Card): string {
  const tags = [
    `<title>${escapeHtml(card.title)} · drop</title>`,
    `<meta name="description" content="${escapeHtml(card.description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="drop">`,
    `<meta property="og:url" content="${escapeHtml(`${config.appOrigin}/d/${id}`)}">`,
    `<meta property="og:title" content="${escapeHtml(card.title)}">`,
    `<meta property="og:description" content="${escapeHtml(card.description)}">`,
  ]

  if (card.image) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(card.image.url)}">`,
      `<meta property="og:image:secure_url" content="${escapeHtml(card.image.url)}">`,
      `<meta property="og:image:type" content="image/jpeg">`,
      // WhatsApp uses the dimensions to choose between a large card and a
      // thumbnail strip, and renders the placeholder at the right shape before
      // the image itself arrives.
      `<meta property="og:image:width" content="${card.image.width}">`,
      `<meta property="og:image:height" content="${card.image.height}">`,
      `<meta property="og:image:alt" content="${escapeHtml(card.image.alt)}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    )
  } else {
    tags.push(`<meta name="twitter:card" content="summary">`)
  }

  return tags.join('')
}

export interface ShareOptions {
  /** The built SPA document, into whose <head> the card tags are spliced. */
  indexHtml: string
}

interface IdParams {
  id: string
}

export async function shareRoutes(app: FastifyInstance, options: ShareOptions): Promise<void> {
  const closing = options.indexHtml.lastIndexOf('</head>')
  if (closing === -1) {
    app.log.warn('web/dist/index.html has no </head> — share links will have no link preview')
    return
  }

  // The document's own <title> is dropped: two of them would leave crawlers to
  // pick, and they do not all pick the same one.
  const before = options.indexHtml.slice(0, closing).replace(/<title>[\s\S]*?<\/title>/i, '')
  const after = options.indexHtml.slice(closing)

  app.get<{ Params: IdParams }>('/d/:id', async (request, reply) => {
    const card = cardFor(request.params.id, Date.now())

    return reply
      .type('text/html; charset=utf-8')
      // Expiry is enforced at read time, so a cached card could outlive the
      // file it describes. Crawlers keep their own copy regardless.
      .header('cache-control', 'no-store')
      .send(before + renderHead(request.params.id, card) + after)
  })
}
