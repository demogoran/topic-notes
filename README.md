# VoiceNotes 🎙️

Mobile-first voice notes app: record → transcribe (EN/UA) → AI-proposed categories → organized notes.

## Stack

- **SvelteKit 3 (Svelte 5, runes)** — frontend + API backend in one app
- **better-sqlite3** — embedded database (WAL), no external DB needed
- **OpenRouter** — [`xiaomi/mimo-v2.6-flash`](https://openrouter.ai/xiaomi/mimo-v2.6-flash) for **both** transcription (audio input) and note categorization
- **adapter-node** — deployable as a plain Node server (`pnpm build && pnpm start`)
- Auth: email + password (scrypt hashing, DB-backed cookie sessions, no verification)

## Setup

```bash
pnpm install
cp .env.example .env   # then edit: set OPENROUTER_API_KEY + AUTH_SECRET
pnpm dev               # dev server at http://localhost:5173
```

### Environment

| Variable | Default | Description |
|---|---|---|
| `DATABASE_PATH` | `./data/app.db` | SQLite file location (created on first run) |
| `SESSION_TTL_DAYS` | `30` | Session cookie lifetime |
| `OPENROUTER_API_KEY` | — | **Required** for transcription/categorization |
| `OPENROUTER_MODEL` | `xiaomi/mimo-v2.6-flash` | Any OpenRouter model with audio input works |
| `OPENROUTER_APP_TITLE` | `VoiceNotes` | Sent as `X-Title` header to OpenRouter |
| `PORT` | `3000` | Prod server port (`pnpm start`) |

> **Note:** microphone capture requires a secure context — `localhost` works in dev; for LAN/phone testing use HTTPS (e.g. `npx localtunnel` or a reverse proxy) or Chrome's `unsafely-treat-insecure-origin-as-secure` flag.

## Production

```bash
pnpm build
pnpm start                # reads PORT / DATABASE_PATH / OPENROUTER_* from env
```

## Architecture

```
src/lib/shared/      types + design tokens + global CSS (framework-agnostic)
src/lib/server/
  db/database.ts     better-sqlite3 singleton + migrations
  db/repositories.ts factory-function repos (users/sessions/categories/notes)
  db/audioStore.ts   recording blob storage (fs, swappable for S3)
  auth/password.ts   scrypt hash/verify (pure)
  auth/authService.ts AuthService class: register/login/session cookie
  ai/organize.ts     pure prompt builders + response parsing
  ai/openRouterClient.ts OpenRouter client class (chat / transcribe / organize)
  notesService.ts    note domain service (create/update + category linking)
  validators.ts      pure request validation
  guards.ts          requireUser endpoint guard
src/lib/client/      api fetch wrapper, Recorder (MediaRecorder) class
src/routes/api/*     JSON endpoints (auth, notes, categories, transcribe, organize)
src/routes/(auth)/   login / register pages
src/routes/(app)/app main app: capture (record orb) + notes tabs
```

API summary:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` \| `/login` \| `/logout` | account lifecycle |
| GET | `/api/auth/me` | current user |
| GET/POST | `/api/notes` | list / create (with `categories: string[]`, auto-created) |
| GET/PATCH/DELETE | `/api/notes/:id` | manage a note |
| POST | `/api/notes/:id/categorize` | re-run AI categorization on an existing note |
| GET/POST | `/api/categories` | list / create |
| PATCH/DELETE | `/api/categories/:id` | rename / delete (links cascade) |
| POST | `/api/transcribe` | multipart `audio` → transcript |
| POST | `/api/organize` | transcript → cleaned text + language + proposed categories |
