# chainaim-paywall. Build context: services/paywall.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
