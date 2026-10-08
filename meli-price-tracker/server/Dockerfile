# API de la base compartida de precios. Debian slim (no Alpine): better-sqlite3 trae binarios precompilados para glibc.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
ENV DB_PATH=/data/prices.db PORT=8080
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080
CMD ["node", "src/index.js"]
