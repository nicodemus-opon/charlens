# ---- base: pnpm via corepack ----
# Debian (glibc), NOT Alpine (musl): onnxruntime-node ships a glibc-linked
# libonnxruntime.so that needs /lib64/ld-linux-x86-64.so.2 as its dynamic
# loader. That path does not exist on musl, so every model load fails with
# ERR_DLOPEN_FAILED ("Error loading shared library ld-linux-x86-64.so.2"),
# dropping embeddings to keyword-only mode and keyphrase tags to phase-1.
FROM node:22-slim AS base
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
# small via the standalone ./build output + slim Debian base.)
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production \
	# Process-wide counterpart to src/lib/server/net.ts: disable Node's Happy
	# Eyeballs so outbound RSS/article fetches use DNS order (IPv4 first)
	# on networks with broken IPv6 (e.g. news.ycombinator.com ETIMEDOUT).
	NODE_OPTIONS=--no-network-family-autoselection

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
