# chainaim-gateway. Node runs the TypeScript directly: no build step and no
# npm dependencies. Build context: the repository root.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY packages/route-engine/package.json packages/route-engine/package.json
COPY packages/route-engine/dist packages/route-engine/dist
COPY config config
COPY services/gateway/src services/gateway/src
EXPOSE 8700
# The ledger goes to the volume mounted at /data. The process runs as root so
# it can write to Railway's root-owned volume.
ENTRYPOINT ["node", "services/gateway/src/main.ts"]
CMD ["--host", "::", "--port", "8700", "--api-key-env", "CHAINAIM_GATEWAY_KEY", "--catalog", "config/catalog.json", "--health-interval-ms", "0", "--presidio-url", "http://presidio.railway.internal:3000", "--ledger", "/data/ledger"]
