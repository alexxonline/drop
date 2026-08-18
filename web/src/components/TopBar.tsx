import { useEffect, useState } from 'preact/hooks'
import type { PublicDrop } from '../types.ts'
import { formatBytes, formatDate, formatRemaining, kindLabel } from '../utils.ts'
import { NativeLink } from './NativeLink.tsx'

/** Chrome shown above every shared file: what it is, how long it lasts, how to keep it. */
export function TopBar({ drop }: { drop: PublicDrop }) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <header class="topbar">
      <a class="brand small" href="/" title="drop">
        <span class="brand-mark" aria-hidden="true">
          ◆
        </span>
      </a>

      <div class="topbar-title">
        <strong class="ellipsis">{drop.filename}</strong>
        <span class="muted small">
          <span class="badge subtle">{kindLabel(drop.kind)}</span>
          {formatBytes(drop.size)}
          {drop.entryCount > 1 ? ` · ${drop.entryCount} files` : ''}
        </span>
      </div>

      <span class="muted small nowrap" title={`Expires ${formatDate(drop.expiresAt)}`}>
        {formatRemaining(drop.expiresAt, now)}
      </span>

      <NativeLink class="button small" href={drop.downloadUrl}>
        Download
      </NativeLink>
    </header>
  )
}
