# ---- base: pnpm via corepack ----
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- deps: install all deps (dev needed for build) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---- build: produce the adapter-node standalone server in ./build ----
# Dummy env so SvelteKit postbuild analyse (which imports server modules)
# doesn't fail on missing DATABASE_URL. Real values come from compose/Coolify.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL=postgres://build:build@localhost:5432/build \
	BETTER_AUTH_SECRET=build-only-dummy-secret-0000000000000000 \
	ORIGIN=http://localhost:3000
RUN pnpm build

# ---- runner: minimal production image ----
# (prod-deps stage removed: drizzle-kit must run migrations at container
# start, and pruning dev deps drops the bins it needs. The runtime stays
# small via the standalone ./build output + alpine base.)
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src/lib/server/db ./src/lib/server/db
COPY --from=build /app/build ./build

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "build"]
