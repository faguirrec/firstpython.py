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
# el historial del experimento no.
RUN mkdir -p /app/data /app/logs /app/reports
VOLUME ["/app/data", "/app/logs", "/app/reports"]

ENV DATABASE_URL=/app/data/trading_bot.db \
    LOG_FILE=/app/logs/trading_bot.jsonl

HEALTHCHECK --interval=5m --timeout=30s --start-period=1m \
    CMD python -m trading_bot status > /dev/null || exit 1

CMD ["python", "-m", "trading_bot", "run"]
