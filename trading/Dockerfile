# Imagen de despliegue continuo para el bot de trading.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=UTC

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY pyproject.toml ./
COPY src ./src
COPY scripts ./scripts
RUN pip install --no-cache-dir --no-deps -e .

# La base de datos y los logs viven en volúmenes: el contenedor es desechable,
# el historial del experimento no. El usuario no-root debe poder escribirlos.
RUN useradd --create-home --uid 10001 trader \
    && mkdir -p /app/data /app/logs /app/reports \
    && chown -R trader:trader /app
VOLUME ["/app/data", "/app/logs", "/app/reports"]

ENV DATABASE_URL=/app/data/trading_bot.db \
    LOG_FILE=/app/logs/trading_bot.jsonl \
    HEALTH_PORT=8080

EXPOSE 8080

# Nada en el bot necesita root: si algo se compromete, que no sea con uid 0.
USER trader

# `status --strict` devuelve código distinto de cero cuando el kill switch está
# activo, el circuit breaker abierto, el broker inalcanzable o el scheduler
# detenido. Sin --strict el chequeo no podía fallar nunca.
HEALTHCHECK --interval=5m --timeout=30s --start-period=2m --retries=3 \
    CMD python -m trading_bot status --strict > /dev/null || exit 1

CMD ["python", "-m", "trading_bot", "run"]
