# api/Dockerfile — NestJS API (multi-stage, minimal image)
# Stage 1: install + compile
FROM node:20-alpine AS builder

# python3 / make / g++ are required by node-gyp for native addons (e.g. bcrypt).
# Without them, npm ci --ignore-scripts is the only workaround — but that flag
# silently skips the postinstall compile step, breaking bcrypt at runtime.
# We keep the toolchain here and let npm ci run scripts normally.
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
# NOTE: --ignore-scripts intentionally removed.
# bcrypt (and any other native addon) requires the node-gyp postinstall compile
# step.  Skipping it causes bcrypt.hash/compare to throw at runtime, completely
# breaking login and registration in production.
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src

RUN npm run build

# Strip devDependencies from node_modules in-place so the runner stage
# receives a lean, already-compiled production module tree.
RUN npm prune --production

# Stage 2: production image
FROM node:20-alpine AS runner

RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
# Copy the pruned, pre-compiled node_modules from the builder.
# This avoids running npm ci again in the runner stage (which has no build
# toolchain) and guarantees native binaries compiled in the builder are
# carried over intact.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/main"]
