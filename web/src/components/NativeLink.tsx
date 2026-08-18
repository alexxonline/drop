import type { ComponentChildren } from 'preact'

/**
 * A link the *server* has to answer, not the client router.
 *
 * preact-iso's LocationProvider listens for clicks on `window` and hijacks every
 * same-origin `<a>`, pushing the URL through the SPA router instead of letting
 * the browser navigate. That is right for page links and wrong for the OAuth
 * entry point and for raw file URLs — in development those share the app's
 * origin, so the router swallows the click and renders "Not found".
 *
 * Preact binds `onClick` on the element itself rather than delegating, so
 * stopping propagation here means the click never reaches preact-iso's window
 * listener and the browser performs a real navigation. Modifier-clicks are
 * unaffected: nothing calls `preventDefault`.
 */
export function NativeLink(props: {
  href: string
  class?: string
  title?: string
  children: ComponentChildren
}) {
  const { children, ...rest } = props
  return (
    <a {...rest} onClick={(event) => event.stopPropagation()}>
      {children}
    </a>
  )
}
