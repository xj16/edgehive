# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# EdgeHive — multi-stage Node image.
#
# EdgeHive has zero runtime-native dependencies and executes its TypeScript
# sources directly via Node 22's `--experimental-strip-types`, so there is no
# build/transpile step: we just install prod deps and copy the sources. The
# final image runs on Google's distroless base (no shell, no package manager)
# for a small, hardened attack surface.
# ---------------------------------------------------------------------------

# --- deps: install production dependencies with a clean, reproducible tree ---
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime: distroless, non-root, TS executed via type-stripping ----------
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    EDGEHIVE_USE_EMULATOR=false

# node_modules from the deps stage, then the application sources.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY entrypoints ./entrypoints
COPY public ./public

EXPOSE 8787

# distroless nodejs images set node as the entrypoint; pass node's flags + file.
CMD ["--experimental-strip-types", "entrypoints/node.ts"]
