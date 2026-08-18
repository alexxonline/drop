import { useEffect, useState, useMemo } from 'preact/hooks'
import { useRoute } from 'preact-iso'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api, ApiError } from '../api.ts'
import { TopBar } from '../components/TopBar.tsx'
import { NativeLink } from '../components/NativeLink.tsx'
import type { PublicDrop } from '../types.ts'
import { formatBytes } from '../utils.ts'

/** Above this, inline rendering would lock up the tab; offer the file instead. */
const INLINE_TEXT_LIMIT = 2 * 1024 * 1024

type ViewerState =
  | { status: 'loading' }
  | { status: 'ok'; drop: PublicDrop }
  | { status: 'expired' | 'missing' }

export function Viewer() {
  const { params } = useRoute()
  const [state, setState] = useState<ViewerState>({ status: 'loading' })
  const id = params.id

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })

    api
      .drop(id)
      .then((drop) => {
        if (!cancelled) setState({ status: 'ok', drop })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const expired = err instanceof ApiError && err.status === 410
        setState({ status: expired ? 'expired' : 'missing' })
      })

    return () => {
      cancelled = true
    }
  }, [id])

  if (state.status === 'loading') return <div class="page-loading">Loading…</div>

  if (state.status !== 'ok') {
    return (
      <div class="centred">
        <div class="card notice">
          <h1>{state.status === 'expired' ? 'This link has expired' : 'Link not found'}</h1>
          <p class="muted">
            {state.status === 'expired'
              ? 'The file reached its expiry time and was deleted from storage.'
              : 'This link does not exist, or it was deleted.'}
          </p>
          <a class="button ghost" href="/">
            Go to drop
          </a>
        </div>
      </div>
    )
  }

  return (
    <div class="viewer">
      <TopBar drop={state.drop} />
      <div class={`viewer-body kind-${state.drop.kind}`}>
        <Content drop={state.drop} />
      </div>
    </div>
  )
}

function Content({ drop }: { drop: PublicDrop }) {
  switch (drop.kind) {
    case 'image':
      return <img class="viewer-image" src={drop.contentUrl} alt={drop.filename} />

    case 'audio':
      return (
        <div class="viewer-audio">
          <p class="ellipsis">{drop.filename}</p>
          <audio controls preload="metadata" src={drop.contentUrl} />
        </div>
      )

    case 'pdf':
      return <iframe class="viewer-frame" src={drop.contentUrl} title={drop.filename} />

    case 'html':
    case 'site':
      return <SiteFrame drop={drop} />

    case 'text':
    case 'markdown':
      return <TextContent drop={drop} />

    default:
      return (
        <div class="centred">
          <NativeLink class="button" href={drop.downloadUrl}>
            Download {drop.filename}
          </NativeLink>
        </div>
      )
  }
}

/**
 * User HTML runs in an iframe. `allow-same-origin` is safe *because* the content
 * is served from a different origin than the app — so it is dropped in the
 * single-origin development fallback, where it would defeat the sandbox.
 */
function SiteFrame({ drop }: { drop: PublicDrop }) {
  const sandbox = useMemo(() => {
    const permissions = [
      'allow-scripts',
      'allow-forms',
      'allow-popups',
      'allow-popups-to-escape-sandbox',
      'allow-modals',
      'allow-downloads',
    ]

    let crossOrigin: boolean
    try {
      crossOrigin = new URL(drop.contentUrl, location.href).origin !== location.origin
    } catch {
      crossOrigin = false
    }
    if (crossOrigin) permissions.push('allow-same-origin')

    return permissions.join(' ')
  }, [drop.contentUrl])

  return (
    <iframe class="viewer-frame" src={drop.contentUrl} sandbox={sandbox} title={drop.filename} />
  )
}

type TextState =
  | { status: 'loading' }
  | { status: 'too-big' }
  | { status: 'ok'; text: string }
  | { status: 'error'; message: string }

function TextContent({ drop }: { drop: PublicDrop }) {
  const [state, setState] = useState<TextState>({ status: 'loading' })

  useEffect(() => {
    if (drop.size > INLINE_TEXT_LIMIT) {
      setState({ status: 'too-big' })
      return
    }

    let cancelled = false
    fetch(drop.contentUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`Could not load the file (${res.status}).`)
        return res.text()
      })
      .then((text) => {
        if (!cancelled) setState({ status: 'ok', text })
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ status: 'error', message: err.message })
      })

    return () => {
      cancelled = true
    }
  }, [drop.contentUrl, drop.size])

  if (state.status === 'loading') return <div class="page-loading">Loading…</div>

  if (state.status === 'too-big') {
    return (
      <div class="centred">
        <div class="card notice">
          <h1>Too large to preview</h1>
          <p class="muted">
            This file is {formatBytes(drop.size)}. Download it to read the whole thing.
          </p>
          <NativeLink class="button" href={drop.downloadUrl}>
            Download
          </NativeLink>
        </div>
      </div>
    )
  }

  if (state.status === 'error') return <p class="alert">{state.message}</p>

  if (drop.kind === 'markdown') {
    // Sanitised before it ever reaches the DOM: markdown may contain raw HTML.
    const html = DOMPurify.sanitize(marked.parse(state.text, { async: false }), {
      ADD_ATTR: ['target'],
    })
    return <article class="prose" dangerouslySetInnerHTML={{ __html: html }} />
  }

  return <pre class="plaintext">{state.text}</pre>
}

// Opens links inside rendered markdown in a new tab without leaking the opener.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})
