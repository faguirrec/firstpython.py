# Imagen única con el frontend compilado y la API: un solo puerto, un solo proceso.
#
# Se usa Debian slim y no Alpine a propósito: better-sqlite3 publica binarios
# precompilados para glibc, y en Alpine (musl) tendría que compilarse desde el
# código fuente, lo que exige un compilador de C en la imagen.

# --- Etapa 1: frontend ---
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Etapa 2: backend ---
FROM node:22-bookworm-slim AS server
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build

# --- Etapa 3: imagen final ---
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app/server

# Sólo dependencias de producción: la imagen queda bastante más liviana.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=server /app/server/dist ./dist
COPY --from=web /app/web/dist /app/web/dist

# La base vive en un volumen montado, para que sobreviva a cada despliegue.
ENV DB_PATH=/data/hogar.db
ENV PORT=8080
EXPOSE 8080

# El proceso corre sin privilegios; el volumen se monta a nombre de este usuario.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
