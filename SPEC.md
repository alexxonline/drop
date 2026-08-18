# drop — Specification

Ephemeral file sharing. Sign in with Google, drop a file, get a public link that
dies on a timer.

---

## 1. Product summary

An authenticated user drags a file onto the app (or browses for one). The server
validates it, stores it in Cloudflare R2, and returns a public link on the app's
own domain containing a UUID:

```
https://drop.example.com/d/3f9c1e2a-…-b7
```

Anyone with that link — no authentication — sees a rendered view of the file:
text, markdown, an image, an audio player, a PDF, or, for HTML and ZIP uploads, a
live static site inside an iframe with a top bar. When the TTL elapses the R2
objects are deleted and the link returns a clean "expired" page.

---

## 2. Decisions

These were settled up front; each replaces a range of viable alternatives.

| Area | Decision | Rationale |
|---|---|---|
| Auth | Google OAuth 2.0 (authorization code + PKCE), **email allowlist** via `ALLOWED_EMAILS` | Private tool. No user table, no signup flow, no GCP setup beyond one OAuth client. |
| Session | Stateless HS256 JWT in an HttpOnly, host-only cookie | No session store to run or expire. Host-only scoping is what keeps the cookie off the content host. |
| Metadata | SQLite (`better-sqlite3`), behind a small repository module | One file, zero infra, synchronous. Swappable — every query lives in `server/src/db.ts`. |
| Upload path | Multipart **proxied through Fastify**, then server → R2 | The server must see the bytes anyway: type validation, ZIP inspection, HTML rewriting. Presigned URLs would need a second round trip regardless. |
| R2 access | **S3-compatible API**, signed with `aws4fetch` | R2's real object API. `aws4fetch` is ~4 KB versus ~10 MB for `@aws-sdk/client-s3`, and covers put/get/list/delete. |
| Expiry | In-app sweeper + hard expiry check on every read | Per-upload TTL granularity in seconds. Reads check `expires_at` before touching R2, so a link dies exactly on time even if the sweep lags. |
| Max upload | 100 MB (`MAX_UPLOAD_BYTES`) | Single-shot PUT to R2, no multipart complexity. |
| TTL | User-selectable 1h / 6h / 24h / 7d / 30d, default 24h, server-clamped to `MAX_TTL_SECONDS` | |
| Isolation | User HTML/ZIP served from a **separate hostname** (`CONTENT_ORIGIN`) | See §7. This is the security boundary the whole design rests on. |
| ZIP sites | Rendered in an iframe with the same top bar as every other kind | Consistent chrome; the visitor always sees filename, expiry and download. |
| Link previews | `/d/:id` is server-rendered with Open Graph tags; images get a JPEG thumbnail generated at upload time | Chat apps do not run JavaScript, so an SPA-only `<head>` previews as a bare URL. See §6. |
| Dashboard | `/files` — active uploads, time remaining, copy link, delete now | |
| Deploy | Docker on a VPS; SQLite on a mounted volume; in-process sweeper | |

---

## 3. Accepted file types

Detection is by **file extension**, cross-checked against the browser-supplied
MIME type. Unknown extensions are rejected with 415. The table lives in one
object (`server/src/types.ts`) and is trivially extended.

| Kind | Extensions | Served as |
|---|---|---|
| `text` | `.txt`, `.log` | `<pre>` in the viewer |
| `markdown` | `.md`, `.markdown` | Rendered client-side (`marked` + `DOMPurify`) |
| `image` | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` | `<img>` |
| `audio` | `.wav`, `.mp3`, `.aac`, `.m4a`, `.ogg`, `.flac` | `<audio controls>` with range requests |
| `pdf` | `.pdf` | `<iframe>` pointed at the content origin |
| `html` | `.html`, `.htm` | Stored as a one-page site, iframed |
| `site` | `.zip` | Unpacked, iframed |

> **Note on scope.** The brief named txt, md, pdf, wav/mp3/aac, jpg/png/gif,
> html and zip. `.log`, `.markdown`, `.webp`, `.m4a`, `.ogg` and `.flac` are
> included as obvious siblings — `.aac` without `.m4a` in particular surprises
> people, since most AAC files ship in an MP4 container. Delete the rows from
> `types.ts` if you want the literal list.
>
> **SVG is deliberately absent.** SVG is a script-execution vector; it would need
> the same iframe treatment as HTML, and is not worth it for an image type nobody
> asked for.

---

## 4. Architecture

```
                          ┌──────────────────────────────┐
  drop.example.com  ──────▶  Fastify (single process)    │
  (APP_ORIGIN)            │                              │
    SPA · /api · /auth    │   ┌─ auth      Google OAuth   │
                          │   ├─ api       upload/list    │
  usercontent.example.com │   ├─ content   /f/:id /s/:id  │──▶ Cloudflare R2
  (CONTENT_ORIGIN)   ─────▶   └─ sweeper   every 60s      │    (S3 API)
    /f/:id · /s/:id/*     │                              │
                          │        SQLite (metadata)     │
                          └──────────────────────────────┘
```

One Node process, two hostnames. A Fastify `onRequest` hook inspects
`request.host` and refuses app routes on the content host and content routes on
the app host. If `CONTENT_ORIGIN` is unset (local dev) both collapse onto one
host and the server logs a warning at boot.

### Layout

```
drop/
├── SPEC.md · README.md · Dockerfile · docker-compose.yml · Caddyfile · .env.example
├── package.json                  npm workspaces: server, web
├── server/
│   ├── tsconfig.json             emits src → dist
│   ├── tsconfig.test.json        typechecks src + test, no emit
│   ├── src/
│   │   ├── index.ts              bootstrap + graceful shutdown
│   │   ├── config.ts             env parsing and validation
│   │   ├── app.ts                Fastify instance, plugins, host routing, CSP
│   │   ├── db.ts                 SQLite schema, row types, every query
│   │   ├── r2.ts                 aws4fetch S3 client: put/get/list/delete
│   │   ├── types.ts              DropKind + extension → { kind, mime } table
│   │   ├── preview.ts            share-card thumbnails (sharp)
│   │   ├── html.ts               HTML escaping, shared by the two renderers
│   │   ├── zip.ts                safe ZIP inspection and extraction
│   │   ├── sweeper.ts            expiry job
│   │   ├── auth.ts               OAuth routes, session sign/verify, guards
│   │   └── routes/
│   │       ├── api.ts            /api/*
│   │       ├── content.ts        /f/:id, /f/:id/preview, /s/:id/*
│   │       └── share.ts          /d/:id — the SPA with Open Graph tags
│   └── test/                     integration tests, R2 stubbed in memory
└── web/
    ├── tsconfig.json             checker only; Vite does the transpiling
    └── src/
        ├── main.tsx · app.tsx · session.tsx · style.css
        ├── api.ts · types.ts · utils.ts
        ├── pages/      Login · Upload · Files · Viewer · NotFound
        └── components/ Dropzone · TopBar · Header · CopyField
```

**TypeScript layout.** Relative imports carry real `.ts`/`.tsx` extensions, so
`node src/index.ts` runs the server directly under Node's type stripping while
`rewriteRelativeImportExtensions` turns them into `.js` in the compiled output.
`erasableSyntaxOnly` bans anything Node cannot strip (enums, namespaces,
parameter properties), which keeps the sources you run in development and the
`dist/` you ship behaviourally identical.

The two workspaces typecheck independently. `web/src/types.ts` restates the API
contract — `DropKind`, the owner view, the public view — rather than importing it
from the server, whose types drag in Fastify and node typings the browser build
has no use for. It is a small surface and the file says to keep it in step.

---

## 5. Data model

```sql
CREATE TABLE drops (
  id           TEXT PRIMARY KEY,   -- UUID v4, the public identifier
  owner_email  TEXT NOT NULL,
  filename     TEXT NOT NULL,      -- original, for display and download
  kind         TEXT NOT NULL,      -- text|markdown|image|audio|pdf|html|site
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,   -- bytes uploaded (compressed, for zips)
  object_key   TEXT,               -- what /f/:id serves: the file, the html
                                   -- index, or a zip's retained original
  prefix       TEXT NOT NULL,      -- 'drops/<id>/' — deletion unit
  entry_count  INTEGER NOT NULL DEFAULT 1,
  preview_width  INTEGER,          -- share-card thumbnail size; NULL when the
  preview_height INTEGER,          -- drop has no preview image
  created_at   INTEGER NOT NULL,   -- epoch ms
  expires_at   INTEGER NOT NULL,   -- epoch ms
  deleted_at   INTEGER             -- set by sweeper or manual delete
);
```

R2 keys:

- single file — `drops/<id>/<sanitised filename>`
- image thumbnail — `drops/<id>/preview.jpg`
- html — `drops/<id>/site/index.html`
- zip — `drops/<id>/site/<entry path>`, plus the original archive at
  `drops/<id>/original/<sanitised filename>` so the top bar's download button
  works for sites too

Everything belonging to a drop lives under one prefix, so deletion is
"list the prefix, delete what's there" and cannot orphan objects.

---

## 6. HTTP surface

### App origin

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/auth/google/login` | — | Start OAuth; sets a 10-minute state/PKCE cookie |
| `GET` | `/auth/google/callback` | — | Verify `id_token`, check allowlist, set session |
| `POST` | `/auth/logout` | session | Clear session cookie |
| `GET` | `/api/me` | — | `{ email, name, picture }` or `401` |
| `POST` | `/api/uploads?ttl=<s>` | session | `multipart/form-data`, one `file` part |
| `GET` | `/api/uploads` | session | Caller's non-expired drops |
| `DELETE` | `/api/uploads/:id` | session, owner | Delete immediately |
| `GET` | `/api/drops/:id` | — | Public viewer metadata |
| `GET` | `/d/:id` | — | The SPA, with the drop's Open Graph tags in `<head>` |
| `GET` | `/*` | — | SPA (`/`, `/login`, `/files`) |

`POST /api/uploads` responds:

```json
{ "id": "…", "url": "https://drop.example.com/d/…", "kind": "image",
  "filename": "cat.png", "size": 81234, "expiresAt": 1755212345678 }
```

`GET /api/drops/:id` responds `410 Gone` past expiry, `404` if unknown, else:

```json
{ "id": "…", "filename": "site.zip", "kind": "site", "mime": "text/html",
  "size": 40213, "expiresAt": 1755212345678,
  "contentUrl": "https://usercontent.example.com/s/…/",
  "downloadUrl": "https://usercontent.example.com/f/…?download=1" }
```

TTL is a query parameter rather than a form field so the server never depends on
multipart part ordering.

### Content origin

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/f/:id` | Raw bytes. Honours `Range` (audio scrubbing). `?download=1` forces attachment. |
| `GET` | `/f/:id/preview` | The share-card thumbnail (`image/jpeg`). `404` when the drop has none. |
| `GET` | `/s/:id/*` | Static site assets. Empty or trailing-slash path → `index.html`; a 404 retries `<path>/index.html`. |

Both return `410` past expiry — `/f` as JSON, `/s` as a small HTML page, since a
browser is rendering it directly.

### Link previews

A share link is only ever pasted somewhere, and the thing that fetches it first
is a crawler — WhatsApp, Signal, Slack, iMessage — that reads the `<head>` and
runs no JavaScript. `/d/:id` therefore renders server-side: the built
`index.html`, with its `<title>` replaced and Open Graph tags spliced in ahead
of `</head>`. Browsers get the same document and boot the SPA as before, so
there is no user-agent sniffing and no second code path to keep in step.

Expired and unknown ids still answer `200` with the SPA, which renders its own
state; their cards read "Link expired" and "Link not found" and carry no image.
The response is `no-store` — expiry is a read-time check, and a cached card
would outlive the file it describes.

**Thumbnails.** `og:image` never points at the original upload: WhatsApp
silently drops a preview image over roughly 600 KB, which most photos exceed
several times. Instead `sharp` renders a JPEG at upload time — EXIF rotation
applied, longest edge 1200 px, quality stepped down until it fits in 500 KB —
stored at `drops/<id>/preview.jpg` and served from the content origin. Its
dimensions live on the row, so the page can advertise `og:image:width`/`height`
and omit `og:image` entirely when there is no thumbnail. An image `sharp`
cannot decode uploads normally and simply gets a text-only card.

The crawler fetches the page and the thumbnail from the platform's servers, not
the recipient's device: sharing a link tells WhatsApp the link exists, and hands
it a downscaled copy of the image. That is inherent to link previews everywhere.

---

## 7. Security

**Origin separation is the load-bearing control.** Uploaded HTML and ZIP sites
run arbitrary JavaScript. If they ran on the app's origin, that JavaScript could
call `/api/uploads` with the visitor's session cookie. So:

- The app SPA and API live on `APP_ORIGIN`. Nothing user-supplied is ever served
  there.
- All user bytes — `/f/:id` *and* `/s/:id/*` — are served from `CONTENT_ORIGIN`.
  Raw file serving is included because PDFs can execute script too.
- The session cookie is **host-only** (no `Domain` attribute), so it is never
  transmitted to the content host even when the two are sibling subdomains.
- Because the iframe is already cross-origin, its `sandbox` can include
  `allow-same-origin` — user sites keep working `localStorage` and relative
  fetches while remaining unable to reach the app origin.

Layered on top:

- **CSP** on the app origin: `script-src 'self'`, `object-src 'none'`,
  `base-uri 'none'`, `frame-ancestors 'none'`; `frame-src`/`img-src`/`media-src`/
  `connect-src` allow `'self'` plus the content origin. Relaxed in dev for Vite HMR.
- **CSRF**: `SameSite=Lax` on the session cookie, plus an `Origin` header check on
  every state-changing route.
- **Markdown**: rendered with `marked`, then sanitised with `DOMPurify` before it
  reaches the DOM.
- **ZIP bombs and traversal**, enforced *before* any extraction, from the central
  directory: ≤ `MAX_ZIP_ENTRIES` (2000) entries, ≤ `MAX_ZIP_TOTAL_BYTES` (300 MB)
  uncompressed, ≤ 200:1 overall compression ratio. Absolute paths, `..` segments,
  symlinks and `__MACOSX/` are rejected or skipped.
- **Memory**: uploads are buffered to compute the SigV4 payload hash, so
  concurrent uploads are capped by a semaphore (3) and `@fastify/rate-limit`
  guards the public routes.
- **`X-Content-Type-Options: nosniff`** everywhere; content types on site assets
  come from the extension table, not from sniffing.
- **Enumeration**: identifiers are UUID v4 (122 bits of entropy). Links are
  unguessable but not secret — anyone holding one can read the file, as specified.

---

## 8. Expiry

TTL is chosen at upload, clamped to `[60, MAX_TTL_SECONDS]`, and stored as an
absolute `expires_at`.

1. **Read-time check.** Every read path compares `expires_at` to now before
   touching R2 and returns `410` if past. This is what makes expiry exact.
2. **Sweeper.** Every `SWEEP_INTERVAL_MS` (default 60 s), and once at boot: select
   drops where `expires_at <= now AND deleted_at IS NULL`, list each prefix in R2,
   delete every object, then stamp `deleted_at`. Listing rather than trusting a
   file manifest means a crash mid-upload cannot leave objects behind.
3. **Manual delete** from `/files` runs the same path immediately.

Rows are kept after deletion so an expired link can render "this expired" rather
than "not found"; a second pass drops rows older than 30 days.

---

## 9. Configuration

```ini
PORT=3000
APP_ORIGIN=http://localhost:5173
CONTENT_ORIGIN=            # unset in dev → same origin, warns at boot
SESSION_SECRET=            # openssl rand -hex 32
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
ALLOWED_EMAILS=you@gmail.com
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=drop
DATABASE_PATH=./data/drop.db
MAX_UPLOAD_BYTES=104857600
DEFAULT_TTL_SECONDS=86400
MAX_TTL_SECONDS=2592000
SWEEP_INTERVAL_MS=60000
MAX_ZIP_ENTRIES=2000
MAX_ZIP_TOTAL_BYTES=314572800
```

Missing or malformed values fail fast at boot with a named error.

**Google Cloud setup.** APIs & Services → Credentials → OAuth client ID → Web
application. Authorised redirect URI: `${APP_ORIGIN}/auth/google/callback`. Scopes
`openid email profile` only, so the consent screen can stay in testing mode with
the allowlisted addresses added as test users.

**Cloudflare setup.** R2 → create bucket → API → *Create API token* scoped to
Object Read & Write for that bucket. The bucket stays private; the app is the only
reader.

---

## 10. Deployment

`docker compose up -d`. One container, one volume for `/data` (SQLite), env from
`.env`. Put a TLS terminator (Caddy, nginx, Cloudflare proxy) in front and point
both hostnames at it.

Local development: `npm run dev` runs Fastify on `:3000` and Vite on `:5173` with
`/api`, `/auth`, `/f` and `/s` proxied. `npm run build` emits `web/dist`, which
the server serves via `@fastify/static` in production.

---

## 11. Deliberately out of scope

Password-protected links, view counters, virus scanning, multi-user sharing,
resumable uploads, thumbnail generation, and any file type not in §3.
