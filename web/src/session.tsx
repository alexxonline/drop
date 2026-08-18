import { createContext } from 'preact'
import type { ComponentChildren } from 'preact'
import { useContext, useEffect, useState, useCallback } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { api } from './api.ts'
import type { SessionUser } from './types.ts'

interface SessionState {
  status: 'loading' | 'ready'
  user: SessionUser | null
}

interface SessionValue extends SessionState {
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = createContext<SessionValue>({
  status: 'loading',
  user: null,
  refresh: async () => {},
  signOut: async () => {},
})

export function SessionProvider({ children }: { children: ComponentChildren }) {
  const [state, setState] = useState<SessionState>({ status: 'loading', user: null })

  const refresh = useCallback(async () => {
    try {
      const user = await api.me()
      setState({ status: 'ready', user })
    } catch {
      setState({ status: 'ready', user: null })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {})
    setState({ status: 'ready', user: null })
  }, [])

  return (
    <SessionContext.Provider value={{ ...state, refresh, signOut }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession(): SessionValue {
  return useContext(SessionContext)
}

/**
 * Wraps routes that need a signed-in user. Renders nothing while the session is
 * still resolving, so a signed-in user never sees a flash of the login screen.
 */
export function RequireAuth({ children }: { children: ComponentChildren }) {
  const { status, user } = useSession()
  const location = useLocation()

  useEffect(() => {
    if (status === 'ready' && !user) {
      location.route(`/login?next=${encodeURIComponent(location.url)}`, true)
    }
  }, [status, user, location])

  if (status === 'loading') return <div class="page-loading">Loading…</div>
  if (!user) return null
  return <>{children}</>
}
