#!/bin/sh
# Runs DB migrations, then starts the SvelteKit node server.
# Resolves DATABASE_URL / RSSHUB_BASE_URL for compose networking and fails
# fast when required secrets are missing so Coolify shows a clear log.
set -eu

# --- resolve DATABASE_URL ------------------------------------------------
# Priority: explicit URL > bundled `db` service > derive from POSTGRES_*.
# Also re-pins loopback hosts: the host-dev .env value
# (postgres://...@localhost:7056/...) is interpolated into the container,
# where localhost is not the db service.
if [ -z "${DATABASE_URL:-}" ]; then
	DATABASE_URL="postgres://${POSTGRES_USER:-charlens}:${POSTGRES_PASSWORD:-change-me-in-coolify}@db:5432/${POSTGRES_DB:-charlens}"
	echo "NOTE: DATABASE_URL not set — using the bundled db service (db:5432)."
elif printf '%s' "$DATABASE_URL" | grep -Eq '@(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$)'; then
	DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#@(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?#@db:5432#')
	echo "NOTE: DATABASE_URL used a loopback host — re-pinned to the db service (db:5432)."
fi
export DATABASE_URL

# --- resolve RSSHUB_BASE_URL --------------------------------------------
# Same story: host-dev .env points at http://localhost:1200, which from
# inside a container can never work. Re-pin to the `rsshub` service.
if [ -n "${RSSHUB_BASE_URL:-}" ] && printf '%s' "$RSSHUB_BASE_URL" | grep -Eq '^[a-z]+://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$)'; then
	RSSHUB_BASE_URL=$(printf '%s' "$RSSHUB_BASE_URL" | sed -E 's#^([a-z]+://)(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?#\1rsshub:1200#')
	export RSSHUB_BASE_URL
	echo "NOTE: RSSHUB_BASE_URL used a loopback host — re-pinned to $RSSHUB_BASE_URL."
fi
if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
	echo "ERROR: BETTER_AUTH_SECRET is not set (generate one: openssl rand -hex 32)" >&2
	exit 1
fi
if [ -z "${ORIGIN:-}" ]; then
	echo "WARNING: ORIGIN is not set — auth callbacks may fail. Set it to your public URL." >&2
fi

echo "Running database migrations..."
./node_modules/.bin/drizzle-kit migrate

echo "Starting charlens..."
exec "$@"
