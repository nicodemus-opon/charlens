# charlens — self-hosted, multi-user RSS reader (Feedly-style)

SvelteKit + TypeScript + Postgres (Docker) + Drizzle + better-auth + shadcn-svelte.

## Self-hosted, multi-user by design

charlens runs on your own server: one instance, one Postgres database, many
user accounts (email + password via better-auth). There is no external
service dependency — accounts, sessions and content are all private to this
server.

- **Feeds and articles are private per user** — each account owns its own
  feeds (and the articles fetched for them).
- **Per-user data** lives in three tables: `feed` (`user_id` owner),
  `subscription` (which of your feeds you follow, and under which category)
  and `user_article_state` (per-user read/saved flags).
- New accounts start empty — add your first feed from the UI.
- Every page requires a session; the only public route is `/login`.
- Set `AUTH_DISABLE_SIGNUP=1` to close registration after your
  accounts are created (sign-in keeps working).

## Run with Docker (local or Coolify)

`docker-compose.yml` ships the full stack — `app` (this repo, built via
`Dockerfile` with `@sveltejs/adapter-node`), `db` (postgres:16) and
`rsshub`. The app runs migrations on start, then serves on internal port
**3000** (`HOST=0.0.0.0`).

```sh
# Full stack locally (app on http://localhost:7786):
DATABASE_URL=postgres://charlens:secret@db:5432/charlens \
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
ORIGIN=http://localhost:7786 \
docker compose up --build

# …or infra only, then run the app with vite:
docker compose up db rsshub
pnpm install && pnpm db:migrate && pnpm dev
```

Open `http://localhost:7786` — you'll be redirected to `/login` to create the
first account, then land on the reader: Today list, per-feed views, search
(`?q=`), Read later, on-demand refresh, Add content dialog.

### Deploy on Coolify (Docker Compose build pack)

1. New resource → Docker Compose, repo root as base directory, this
   `docker-compose.yml`. Give service **`app`** your domain on internal port
   **3000** (e.g. `https://reader.example.com:3000`). Coolify routes by
   domain — the `ports:` entries are for local compose only.
2. Set env vars in Coolify (never commit secrets):
   - `BETTER_AUTH_SECRET` — `openssl rand -hex 32` (required: the app
     refuses to start without it)
   - `ORIGIN=https://reader.example.com` (your public URL — auth callbacks)
   - Optional: `POSTGRES_PASSWORD` — bootstrap password for the bundled
     `db` (defaults to `change-me-in-coolify`; set your own for anything
     reachable). `DATABASE_URL` needs no setup: it defaults to the bundled
     `db` service (`postgres://<user>:<password>@db:5432/<db>`); set it
     only to use an external Postgres.
   - Optional: `RSSHUB_*`, `FULLTEXT_*`, `FEED_REFRESH_*`,
     `AUTH_DISABLE_SIGNUP=1` (defaults in compose cover the rest; note
     `RSSHUB_BASE_URL` defaults to `http://rsshub:1200` for compose
     networking — override per setup).
3. Volumes `pgdata` and `rsshub-data` persist the database and RSSHub cache.
   Healthchecks gate startup (`app` waits for healthy `db`).

All RSS fetching/parsing lives in SvelteKit (`src/lib/server/rss/`).

## RSSHub + full-text scraping

- `docker-compose.yml` ships a self-hosted RSSHub (`diygod/rsshub:latest` on
  host port **1200**). Configure with `RSSHUB_BASE_URL` (default
  `http://localhost:1200`), `RSSHUB_ENABLED=1`, `RSSHUB_TIMEOUT_MS=15000`.
- Add content: paste any link — a feed URL, a site homepage, a YouTube
  channel, anything. The server figures it out in the background: direct feed,
  common feed paths, then self-hosted RSSHub Radar rules (params like channel
  handles are extracted from the pasted URL automatically). See
  https://docs.rsshub.app/guide/ for what RSSHub can generate.
- Truncated stories show **Load full text** in the reader, which
  `POST /api/articles/[id]/fulltext` scrapes (article/main fallback, meta
  author/date/og:image backfill, 7-day cooldown, 2 MB / 15 s caps) into
  `article.content_html` + `article.full_fetched_at`.
- **Automated:** after every scheduled refresh the server backfills truncated
  articles (`FULLTEXT_AUTO_ENABLED=1`, `FULLTEXT_MAX_PER_RUN=10`,
  `FULLTEXT_CONCURRENCY=3`) — same extractor, newest first, failures get the
  7-day cooldown so broken sites aren't retried every tick. Manual
  **Load full text** (`?force=1`) still bypasses the cooldown.

## Automatic fetching

- The server refreshes every stale feed on a schedule (one interval per
  server process, started from `src/hooks.server.ts`, first run 10 s after
  boot). Cadence defaults to 15 min to match the staleness window:
  `FEED_REFRESH_INTERVAL_MIN="15"`, disable with
  `FEED_REFRESH_SCHEDULER_ENABLED="0"`.
- `GET /api/feeds/refresh` (authed) reports scheduler status
  (`running`, `intervalMs`, `lastRunAt`, last counts).

Auth tables come from `pnpm auth:schema` (better-auth → Drizzle schema). Run
it again after upgrading better-auth, then `pnpm db:generate` + `pnpm db:migrate`.

## Developing

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
pnpm dlx sv@0.17.1 create --template minimal --types ts --add prettier vitest="usages:unit,component" playwright tailwindcss="plugins:typography,forms" sveltekit-adapter="adapter:auto" drizzle="database:postgresql+postgresql:postgres.js+docker:yes" better-auth="demo:password" ai-tools="ide:opencode,other" --install pnpm charlens
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.
