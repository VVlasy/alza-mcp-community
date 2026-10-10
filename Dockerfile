# Container image for the cluster deployment (ghcr.io/vvlasy/alza-mcp-community).
# Layout matches the old init-container build: the app lives in /app/src and starts
# with `node /app/src/dist/index.js`, on the same Playwright base the Xvfb sidecar uses.

FROM node:22-bookworm AS build
WORKDIR /app/src
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ALZA_MCP_SKIP_INSTALL=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM mcr.microsoft.com/playwright:v1.59.1-noble
WORKDIR /app/src
ENV NODE_ENV=production
COPY --from=build /app/src/package.json ./package.json
COPY --from=build /app/src/node_modules ./node_modules
COPY --from=build /app/src/dist ./dist
COPY scripts/cf-transport.py ./scripts/cf-transport.py
USER 65532:65532
ENTRYPOINT ["node", "/app/src/dist/index.js"]
