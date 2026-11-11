# Build from the repository root:
#   docker build -f apps/server/Dockerfile -t streamix-server .
# (docker-compose.yml beside this file does exactly that.)
#
# Two stages: the first builds the web app that the server serves; the second is
# the runtime, which carries only the server's production dependencies. The server
# itself has no build step (Node runs the TypeScript directly).
FROM node:22-bookworm-slim AS base
RUN npm install -g pnpm@11
WORKDIR /app

FROM base AS web
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM base AS run
COPY . .
RUN pnpm install --frozen-lockfile --prod --filter @iptv/server... \
 && rm -rf apps/web apps/mobile apps/tizen apps/webos packages
COPY --from=web /app/apps/web/dist apps/web/dist
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7500
EXPOSE 7500
USER node
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=4s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
