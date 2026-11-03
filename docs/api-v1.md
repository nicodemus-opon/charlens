# charlens public API v1

Versioned JSON API for third-party integrations (phone apps, shortcuts,
automation). Session cookies keep working; machines use Bearer tokens.

- Base: `/api/v1` · contract: `/api/v1/openapi.json`
- Auth: `Authorization: Bearer <token>` (Settings → API tokens, shown once).
  Session cookie is accepted as fallback (full `read+write`).
- Envelopes: success `{ ok: true, … }`, error `{ error: { code, message } }`.
- Rate limit: 60 req/min per caller by default (`API_RATE_LIMIT_PER_MIN`);
  expensive routes (refresh, add, fulltext, follow, mark-read, import) are
  capped lower. `429` carries `Retry-After`.
- CORS: same-origin + server-to-server by default. Set `API_CORS_ORIGINS` to
  allow browser cross-origin callers.
- Article lists are excerpt-only (`contentHtml` needs `GET /articles/:id`).
- `cursor` on `/articles` is an offset; `nextCursor: null` = exhausted.
- Mutations that provision work (`POST /feeds`, `/discover/follow`, `/opml`
  import) return `202 { id?, status: "provisioning" }` / `{ added, skipped }`.

## Quickstart

```sh
TOKEN=chl_...  # Settings → API tokens → Create token

curl -H "Authorization: Bearer $TOKEN" localhost:7786/api/v1/health
curl -H "Authorization: Bearer $TOKEN" localhost:7786/api/v1/feeds
curl -H "Authorization: Bearer $TOKEN" \
  "localhost:7786/api/v1/articles?filter=today&limit=20"
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"isRead":true}' localhost:7786/api/v1/articles/123
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/feed.xml"}' localhost:7786/api/v1/feeds
curl -H "Authorization: Bearer $TOKEN" -o feeds.opml localhost:7786/api/v1/opml
```

## Endpoints

| Method & path                                                                    | Scope         | Notes                                              |
| -------------------------------------------------------------------------------- | ------------- | -------------------------------------------------- |
| `GET /health`                                                                    | none (public) | `{ version, rsshubOk }`                            |
| `GET /openapi.json`                                                              | none (public) | machine-readable contract                          |
| `GET /feeds`                                                                     | read          | unread/total counts + collection                   |
| `POST /feeds`                                                                    | write         | `{ url, collection?: id\|name }` → 202             |
| `GET /feeds/:id`                                                                 | read          |                                                    |
| `DELETE /feeds/:id`                                                              | write         | unsubscribe + delete (articles cascade)            |
| `POST /feeds/:id/move`                                                           | write         | `{ collectionId }` (manual only)                   |
| `GET /feeds/refresh`                                                             | read          | scheduler status                                   |
| `POST /feeds/refresh?force=`                                                     | write         | 10 req/min                                         |
| `GET /articles?filter&feedId&collectionId&tagId&viewId&q&limit&cursor&seed&deep` | read          | excerpt-only + tags, `nextCursor`                  |
| `GET /articles/search?q&limit`                                                   | read          | keyword only, per-keystroke safe                   |
| `GET /articles/:id`                                                              | read          | full `contentHtml` + tags                          |
| `PATCH /articles/:id`                                                            | write         | idempotent `{ isRead?, isSaved? }`                 |
| `POST /articles/mark-read`                                                       | write         | `{ ids[] }` or `{ scope }`, 10 req/min             |
| `POST /articles/:id/fulltext?force=`                                             | write         | 7-day cooldown, 10 req/min                         |
| `POST /articles/:id/events`                                                      | write         | `{ kind, value? }` (open/dwell/scroll/…)           |
| `POST /articles/:id/feedback`                                                    | write         | `{ kind: dismiss\|mute_feed\|mute_topic }`         |
| `GET /articles/:id/tags`                                                         | read          |                                                    |
| `PUT /articles/:id/tags`                                                         | write         | `{ tags: string[]\|string }`                       |
| `GET /collections`                                                               | read          | manual + smart views                               |
| `POST /collections`                                                              | write         | `{ name, kind?, rules? }`                          |
| `PATCH /collections/:id`                                                         | write         | rename / smart rules                               |
| `DELETE /collections/:id`                                                        | write         | feeds fall back to General                         |
| `GET /tags`                                                                      | read          | with counts                                        |
| `PATCH /tags/:id`                                                                | write         | rename                                             |
| `DELETE /tags/:id`                                                               | write         |                                                    |
| `GET /discover/search?q&limit&sort`                                              | read          | URL → radar+site feeds; keyword → publishers       |
| `POST /discover/follow`                                                          | write         | `{ url }` or `{ routePath, prefill? }`, 10 req/min |
| `GET /opml`                                                                      | read          | XML download                                       |
| `POST /opml`                                                                     | write         | multipart `file` or raw XML, ≤2 MB, 5 req/min      |
| `GET /settings`                                                                  | read          | resolved settings                                  |
| `PATCH /settings`                                                                | write         | `{ settings: { key: value } }` (whitelisted keys)  |

## Token management

Settings → API tokens: name + scope (read / read+write) + expiry
(never/30/90 days). Max 20 active tokens per user; revoke anytime.
Compromised token → revoke it; plaintexts are hashed (sha256) and never
re-readable. Headless bootstrap: create the first token from the Settings UI
after initial login.
