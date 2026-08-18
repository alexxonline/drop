import { useEffect } from 'preact/hooks'
import { useLocation } from 'preact-iso'
import { useSession } from '../session.tsx'
import { NativeLink } from '../components/NativeLink.tsx'

const ERRORS: Record<string, string> = {
  'not-allowed': 'That Google account is not on the allowlist for this instance.',
  unverified: 'That Google account has no verified email address.',
  expired: 'The sign-in attempt timed out. Please try again.',
  state: 'The sign-in response could not be verified. Please try again.',
  nonce: 'The sign-in response could not be verified. Please try again.',
  issuer: 'The sign-in response could not be verified. Please try again.',
  exchange: 'Google rejected the sign-in. Please try again.',
  access_denied: 'Sign-in was cancelled.',
}

export function Login() {
  const location = useLocation()
  const { status, user } = useSession()

  const next = location.query.next || '/'
  const error = location.query.error

  useEffect(() => {
    if (status === 'ready' && user) location.route(next, true)
  }, [status, user, next, location])

  return (
    <div class="centred">
      <div class="card login-card">
        <h1>drop</h1>
        <p class="muted">
          Share a file behind a link that deletes itself. Sign in to upload — the links you create
          need no account.
        </p>

        {error && <p class="alert">{ERRORS[error] ?? 'Sign-in failed. Please try again.'}</p>}

        <NativeLink class="button google" href={`/auth/google/login?next=${encodeURIComponent(next)}`}>
          <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
            />
            <path
              fill="#FBBC05"
              d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
            />
          </svg>
          Continue with Google
        </NativeLink>
      </div>
    </div>
  )
}
