# Stillblade game server image.
#
# Stage 1 installs the dev tools and bundles the server (ws included) into one file.
# Stage 2 is just Node + that file + the map JSON: no node_modules, no client code.
#
#   docker build -t stillblade-server .
#   docker run --rm -p 8080:8080 stillblade-server

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY shared ./shared
COPY server ./server
COPY tools/build-server.mjs ./tools/build-server.mjs
RUN node tools/build-server.mjs

FROM node:22-alpine
ENV NODE_ENV=production \
    SB_SERVER_PORT=8080 \
    SB_MAPS_DIR=/app/client/public/maps
WORKDIR /app
# The maps sit where the server's built-in default also looks
# (../../client/public/maps from dist/server), so SB_MAPS_DIR is belt and braces.
COPY --from=build /src/dist/server ./dist/server
COPY client/public/maps/*.json ./client/public/maps/
# Files stay root-owned (read-only for the server); the process runs unprivileged.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${SB_SERVER_PORT}/health" || exit 1
CMD ["node", "--enable-source-maps", "dist/server/main.js"]
