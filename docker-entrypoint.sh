#!/bin/sh
# Runs DB migrations, then starts the SvelteKit node server.
# Fails fast when required secrets are missing so Coolify shows a clear log.
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
	echo "ERROR: DATABASE_URL is not set" >&2
	exit 1
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
