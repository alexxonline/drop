import { useLocation } from 'preact-iso'
import { useSession } from '../session.tsx'

export function Header() {
  const { user, signOut } = useSession()
  const location = useLocation()

  const handleSignOut = async () => {
    await signOut()
    location.route('/login', true)
  }

  return (
    <header class="header">
      <a class="brand" href="/">
        <span class="brand-mark" aria-hidden="true">
          ◆
        </span>
        drop
      </a>

      {user && (
        <nav class="header-nav">
          <a href="/" class={location.path === '/' ? 'active' : ''}>
            Upload
          </a>
          <a href="/files" class={location.path === '/files' ? 'active' : ''}>
            Files
          </a>
          <span class="header-user" title={user.email}>
            {user.email}
          </span>
          <button type="button" class="link-button" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </nav>
      )}
    </header>
  )
}
