# drop

Sign in with Google, drop a file, get a public link that deletes itself.

Uploads go to Cloudflare R2. The link is a UUID on your own domain and needs no
authentication to open — it renders the file as text, markdown, an image, an
audio player, a PDF, or, for HTML and ZIP uploads, a live static site inside an
iframe with a top bar. When the TTL runs out (24 hours by default) the objects
are deleted from R2 and the link returns an "expired" page.

Full design rationale, including the security model, is in [SPEC.md](SPEC.md).

## Stack

TypeScript throughout · Fastify · Preact + Vite · SQLite · Cloudflare R2 over
the S3-compatible API.

The server needs no build step in development: relative imports carry real `.ts`
extensions, so `node src/index.ts` runs the sources directly via Node's type
stripping. `tsc` compiles the same sources to `server/dist` for production and
rewrites those extensions to `.js`. `erasableSyntaxOnly` keeps the two paths from
diverging — anything Node cannot strip is a compile error.

## Setup

```bash
npm install
cp .env.example .env
```

### Google OAuth

1. Cloud console → **APIs & Services → Credentials → Create credentials → OAuth
   client ID → Web application**.
2. Fill in the two origin fields — samples below.
3. Put the client ID and secret in `.env`.
4. Scopes stay at `openid email profile`, so the consent screen can remain in
   testing mode — add your allowlisted addresses as test users.

**Authorised JavaScript origins**

```
http://localhost:5173       # npm run dev — Vite serves the UI
http://localhost:3000       # npm start — single process, only if you use it
https://drop.example.com    # production — must equal APP_ORIGIN exactly
```

**Authorised redirect URIs**

```
http://localhost:5173/auth/google/callback
http://localhost:3000/auth/google/callback
https://drop.example.com/auth/google/callback
```

Add only the rows you actually use; extra entries are harmless but easy to
mistake for the live one later.

Things that will cost you an afternoon otherwise:

- **The redirect URI is derived, not configured.** The server builds it as
  `${APP_ORIGIN}/auth/google/callback` (`server/src/config.ts:63`), so whatever
  you register must match `APP_ORIGIN` byte for byte — scheme, host, and port.
  A mismatch fails at Google with `redirect_uri_mismatch` before your app is
  ever reached.
- **Never list `CONTENT_ORIGIN`.** No sign-in happens on the content host, and
  it must never receive the session cookie — that separation is the whole
  security model (SPEC.md §7). `usercontent.example.com` belongs in neither box.
- **JavaScript origins are optional here.** This app uses the server-side
  authorization code flow: the browser is redirected to Google and back, and no
  Google JS SDK ever runs on the page. The field only matters for browser-side
  token clients. Filling it in costs nothing and keeps the console from looking
  half-configured, so the samples above include it.
- **Google's formatting rules.** Origins take no path and no trailing slash;
  redirect URIs need the full path. Plain `http://` is accepted only for
  `localhost` — every other host must be `https://`.

Only addresses in `ALLOWED_EMAILS` can sign in. Everyone else is bounced at the
callback, whatever Google says.

### Cloudflare R2

1. **R2 → Create bucket.**
2. **R2 → API → Create API token**, scoped to *Object Read & Write* on that
   bucket.
3. Fill in `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
   `R2_BUCKET`.

The bucket stays private — no public access, no custom domain needed. The app is
its only reader.

### Session secret

```bash
openssl rand -hex 32   # → SESSION_SECRET
```

## Running it

```bash
npm run dev        # Fastify on :3000, Vite on :5173 — open http://localhost:5173
npm run build      # typechecks both, emits web/dist and server/dist
npm start          # single process serving API and frontend on :3000
npm test           # integration tests, with R2 stubbed in memory
npm run typecheck  # tsc over server (incl. tests) and web, no emit
```

`npm test` runs the `.ts` test files directly — no build required first.

## Deploying

The server needs Docker with the Compose plugin, and nothing else — no Node, no
build toolchain. Everything compiles inside the image.

```bash
git clone <repo> drop && cd drop
cp .env.example .env
$EDITOR .env                  # secrets and both hostnames
docker compose up -d --build
```

One container, one volume for the SQLite file. Put TLS in front of it and point
both hostnames at port 3000. [`Caddyfile`](Caddyfile) does that — edit the two
hostnames, then:

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy issues certificates for both names automatically and passes the `Host`
header through, which is what the app routes on.

### The two hostnames

Uploaded HTML and ZIP sites run arbitrary JavaScript, so they are served from a
**different origin** than the app:

| Hostname | Serves |
|---|---|
| `APP_ORIGIN` — e.g. `drop.example.com` | The UI, the API, and every share link |
| `CONTENT_ORIGIN` — e.g. `usercontent.example.com` | Raw bytes and unpacked sites only |

Both hostnames point at the **same** container — the app splits them by `Host`
header, so there is no second process to run.

The session cookie is host-only, so it is never sent to the content host and
uploaded JavaScript cannot reach the authenticated API. **The server refuses to
start in production if `CONTENT_ORIGIN` is unset or equal to `APP_ORIGIN`.** In
local development both collapse onto one origin and the server warns about it.

Share links always live on `APP_ORIGIN`, so what you paste to people is
`https://drop.example.com/d/<uuid>` regardless.

### Configuration stays out of the image

Nothing is baked in at build time. Every setting is read from `process.env` when
the server boots (`server/src/config.ts`), and the frontend bundle contains no
configuration at all — no `VITE_*` variables, so `web/dist` is identical on every
machine. Compose passes `.env` in at run time via `env_file`, and `.env` is listed
in `.dockerignore` so it never lands in a layer even though the build copies the
tree.

The practical consequence: rotating a key or moving a hostname is an edit plus

```bash
docker compose up -d          # no --build
```

Resist the urge to `ARG`/`ENV` your secrets into the Dockerfile. Baked values sit
in plaintext layer metadata for anyone with the image (`docker history`,
`docker inspect`), and every rotation becomes a rebuild. If you dislike a
plaintext `.env` on disk, drop `env_file` and let Compose read the values from
the environment instead — `SESSION_SECRET: ${SESSION_SECRET:?required}` — fed by
a `chmod 600` systemd `EnvironmentFile=`.

Misconfiguration fails at boot, not at first request: `assertConfig()` reports
every problem at once, so `docker compose logs drop` gives you the full list on
the first try.

## Configuration

Everything is environment variables; see [`.env.example`](.env.example) for the
full list with comments. The ones you are most likely to change:

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_EMAILS` | — | Comma-separated allowlist. Nobody else can sign in. |
| `MAX_UPLOAD_BYTES` | `104857600` | 100 MB. |
| `DEFAULT_TTL_SECONDS` | `86400` | 24 hours. |
| `MAX_TTL_SECONDS` | `2592000` | 30 days. Uploads are clamped to this. |
| `SWEEP_INTERVAL_MS` | `60000` | How often expired objects are reclaimed. |

Expiry is enforced when a link is *read*, not when the sweeper runs, so a link
dies exactly on time even if the sweep is late or fails.

## Accepted files

`.txt` `.log` `.md` `.markdown` `.jpg` `.jpeg` `.png` `.gif` `.webp` `.wav`
`.mp3` `.aac` `.m4a` `.ogg` `.flac` `.pdf` `.html` `.htm` `.zip`

The list lives in one table in `server/src/types.ts`. Anything else is rejected
with 415.

A `.zip` is unpacked and served as a static site. It needs an `index.html` at the
root or inside a single top-level folder; that wrapper folder is stripped so the
site serves from `/`. Archives are inspected before extraction and rejected for
path traversal, absolute paths, symlinks, entry count, uncompressed size, or an
implausible compression ratio.

## Link previews

Paste a share link into WhatsApp — or Signal, Slack, iMessage, Discord — and the
card shows the filename, the kind and size, how long the link has left, and, for
images, the picture itself.

That works because `/d/:id` is rendered by the server rather than the SPA: the
built `index.html` goes out with the drop's Open Graph tags already in
`<head>`, since no crawler runs JavaScript. Browsers get the identical document
and boot the app as usual.

Image drops also get a thumbnail — `sharp` renders a rotation-corrected JPEG,
1200 px on the longest edge and under 500 KB, at upload time. `og:image` points
at that rather than the original, because WhatsApp silently shows no picture
once the image passes roughly 600 KB, which phone photos do several times over.

Two things worth knowing:

- **The preview is fetched by the chat platform, not by the recipient.** Sharing
  a link tells WhatsApp's servers that the link exists and hands them a
  downscaled copy of the image. This is how link previews work everywhere; if a
  drop is sensitive enough that this matters, send it somewhere that is not a
  preview-generating chat app.
- **Only uploads made after this change have a thumbnail.** Older image drops
  still preview, just as a text card. Re-upload to get the picture, or wait for
  the TTL to age them out.
