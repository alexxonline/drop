import type { ComponentChildren } from 'preact'
import { LocationProvider, Router, Route, ErrorBoundary } from 'preact-iso'
import { SessionProvider, RequireAuth } from './session.tsx'
import { Header } from './components/Header.tsx'
import { Upload } from './pages/Upload.tsx'
import { Login } from './pages/Login.tsx'
import { Files } from './pages/Files.tsx'
import { Viewer } from './pages/Viewer.tsx'
import { NotFound } from './pages/NotFound.tsx'

/** The viewer is public and gets its own chrome, so it skips the app header. */
function Shell({ children }: { children: ComponentChildren }) {
  return (
    <>
      <Header />
      <main class="shell">{children}</main>
    </>
  )
}

const Home = () => (
  <Shell>
    <RequireAuth>
      <Upload />
    </RequireAuth>
  </Shell>
)

const MyFiles = () => (
  <Shell>
    <RequireAuth>
      <Files />
    </RequireAuth>
  </Shell>
)

const SignIn = () => (
  <Shell>
    <Login />
  </Shell>
)

const Missing = () => (
  <Shell>
    <NotFound />
  </Shell>
)

export function App() {
  return (
    <LocationProvider>
      <SessionProvider>
        <ErrorBoundary>
          <Router>
            <Route path="/" component={Home} />
            <Route path="/login" component={SignIn} />
            <Route path="/files" component={MyFiles} />
            <Route path="/d/:id" component={Viewer} />
            <Route default component={Missing} />
          </Router>
        </ErrorBoundary>
      </SessionProvider>
    </LocationProvider>
  )
}
