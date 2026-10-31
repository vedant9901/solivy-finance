FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV FINANCE_DATA_DIR=/data
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package*.json ./
# v2.8.2: the runtime stage previously copied neither of these. `npm run start` is
# `node scripts/ensure-local-secret.cjs && next start`, so the image failed to start at all with
# "Cannot find module", and `next start` ran without the project's next.config.mjs.
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/scripts ./scripts
COPY --from=deps /app/node_modules ./node_modules
RUN mkdir -p /data
EXPOSE 3000
CMD ["npm","run","start"]
