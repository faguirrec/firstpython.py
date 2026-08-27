# Bot de trading autónomo multi-agente (Alpaca)

Sistema de trading algorítmico para acciones y ETFs de EE.UU. sobre la API de
Alpaca. Combina señales técnicas con sentimiento de noticias clasificado por un
LLM, filtra cada operación por **valor esperado neto después de costos** y
aprende de sus propios resultados.

Diseñado para un experimento acotado: **USD $30 de capital, 30 días corridos**,
empezando en paper trading.

> Experimento con capital de riesgo mínimo. No es asesoría financiera y no
> garantiza resultados. Empieza en paper y no pases a live sin haber revisado
> los reportes de la corrida en paper.

---

## Arquitectura

Cuatro agentes, cada uno en su módulo, coordinados por un motor común
(`trading_bot/engine.py`) y un scheduler que distingue la sesión de mercado.

| Agente | Módulo | Responsabilidad |
|---|---|---|
| **NewsPulse** | `agents/news_pulse.py` | Ingiere noticias (Alpaca News + Finnhub/NewsAPI opcionales), deduplica entre fuentes, clasifica con Claude en `{ticker, sentiment_score, confidence, horizonte, resumen}` y **persiste** todo. |
| **TraderCore** | `agents/trader_core.py` | Fusiona indicadores técnicos + sentimiento + régimen de mercado, genera órdenes **limit** con fracciones de acción, reconcilia fills y gestiona salidas. |
| **RiskSentinel** | `agents/risk_sentinel.py` | Calcula el EV neto, dimensiona la posición, aplica límites duros y respeta PDT / liquidación T+1. Tiene derecho a veto sobre cualquier orden. |
| **LearningLoop** | `agents/learning_loop.py` | Job nocturno: califica cada trade cerrado contra las señales que lo originaron y ajusta los pesos (estilo bandit). |

Dos módulos de soporte que no son agentes pero deciden qué tan bien funcionan:
`marketdata/` (de dónde vienen los precios) y `backtest/` (si la estrategia
tiene edge antes de arriesgar los 30 días).

Flujo de una decisión:

```
noticias ─► NewsPulse ─► sentimiento persistido ─┐
                                                 ├─► TraderCore (fusión) ─► RiskSentinel ─► orden limit
barras de precio ─► indicadores técnicos ────────┘         │                    │
                                                            │                    └─ EV neto ≤ 0 → descarta
régimen (SPY) ──────────────────────────────────────────────┘
                                     ▼
                        todo queda en SQLite (auditable)
                                     ▼
                LearningLoop (nocturno) ajusta los pesos de cada señal
```

### Cómo se decide si un trade conviene

`RiskSentinel` no compara la señal contra cero, sino contra el costo del viaje
de ida y vuelta:

```
EV_bruto  = notional × movimiento_esperado × confianza
EV_neto   = EV_bruto − comisión − fee_SEC − fee_TAF − spread − slippage
```

* El **fee SEC** (Sección 31) y el **TAF de FINRA** se cobran solo en las
  *ventas*; están modelados con sus tasas y su tope por orden.
* El **spread** se toma del quote real (medio spread por cada lado) y no de una
  suposición, cuando hay quote disponible.
* Los costos son ciertos y el edge no lo es: la confianza escala el EV bruto,
  nunca los costos.

Si `EV_neto ≤ 0`, o queda por debajo de los pisos (`MIN_NET_EV_USD`,
`MIN_NET_EV_BPS`), el trade se descarta **y el rechazo queda registrado con su
motivo**. Esos motivos son parte de los datos del experimento.

### Reglas regulatorias que sí importan con $30

* **PDT (Pattern Day Trader).** Con equity bajo $25.000 en cuenta *margin*,
  FINRA permite 3 day trades por cada 5 días hábiles. El bot lee el tipo de
  cuenta y el `daytrade_count` desde Alpaca, mantiene su propio conteo como piso
  y se detiene **uno antes** del límite (`DAY_TRADE_SAFETY_BUFFER`).
* **Cuenta cash y liquidación T+1.** En cuenta cash no hay límite de day trades,
  pero el efectivo no liquidado no se puede reutilizar: el dimensionamiento usa
  el *non-marginable buying power*, no el equity.
* **Excepción de riesgo.** Un stop loss o el kill switch se ejecutan aunque
  consuman un day trade: mantener una posición perdedora para cuidar el conteo
  es el riesgo peor.
* **Fracciones de acción.** Alpaca solo acepta órdenes fraccionarias con
  `time_in_force=day` y dentro del horario regular; el adaptador lo fuerza y
  rechaza el envío fuera de horario en vez de coleccionar rechazos del broker.

---

## Datos de mercado: qué conviene pagar con $30

La ejecución va por Alpaca. De dónde vienen los **precios** es una decisión
aparte, y `MARKET_DATA_PROVIDER` la hace configurable.

| Proveedor | Plan gratuito | Tiempo real | Costo mensual |
|---|---|---|---|
| **Alpaca Basic** (por defecto) | Tiempo real, feed **IEX** | Sí | $0 · SIP completo ~$99/mes |
| **Polygon.io / Massive** | 5 req/min, **15 min de retraso** | No | Acciones desde ~$29/mes · tiempo real ~$199/mes |
| **Alpha Vantage** | **25 peticiones por día**, 5/min, **sin bid/ask** | No | Tiempo real desde ~$99,99/mes |

**Veredicto para este piloto: quédate en Alpaca.** Cualquier plan de pago cuesta
más por mes que todo el capital del experimento, y las alternativas gratuitas
son peores que la que ya tenemos:

* Alpha Vantage con 25 peticiones diarias no alcanza para un ciclo de 15 minutos
  sobre 8 símbolos (serían ~200 al día), y su endpoint de cotización no trae
  bid/ask, así que **no puede fijar el precio de una orden limit**.
* Polygon gratis sirve para barras, pero con 15 minutos de retraso tampoco puede
  fijar precios.

Sobre la limitación real de IEX: cubre una fracción del volumen consolidado. Eso
afecta menos de lo que parece en este diseño:

* El **volumen relativo** compara el volumen IEX contra su propio promedio de 20
  barras, así que el sesgo se cancela en gran medida.
* El **spread** visto en IEX puede ser más ancho que el NBBO real. Eso hace el
  filtro de EV neto *más conservador*, no más permisivo: el error apunta en la
  dirección segura.

Por eso el módulo existe pero el default no cambia: **subir de feed es un cambio
de configuración, no una reescritura**, cuando el capital lo justifique.

```bash
MARKET_DATA_PROVIDER=polygon
MARKET_DATA_API_KEY=tu_clave
MARKET_DATA_REALTIME=false   # true solo con un plan de pago en tiempo real
```

La regla que el código impone: **una orden limit nunca se fija con datos
rezagados**. Si el proveedor de barras no entrega bid/ask en tiempo real, las
cotizaciones vuelven a Alpaca; si nadie puede darlas, `get_latest_quote` devuelve
`None` y el cálculo de costos usa el medio spread por defecto (conservador) en
vez de confiar en un precio viejo.

---

## Backtesting y calibración

Antes de este módulo, `EDGE_SCALE_BPS=120` y los umbrales de confianza y salida
eran criterio, no medición. El backtest los convierte en números con evidencia
detrás — o muestra que no la hay, que también es un resultado.

```bash
# Simular sobre el historial de la propia cuenta Alpaca
python -m trading_bot backtest --symbols AAPL,MSFT,NVDA --timeframe 1Day --limit 750

# Sobre CSV propios (<SÍMBOLO>.csv con timestamp,open,high,low,close,volume)
python -m trading_bot backtest --source csv --csv-dir ./historico

# Barrido de parámetros con validación fuera de muestra
python -m trading_bot calibrate --min-trades 10 --out-of-sample 0.3
```

**Por qué este backtest no se miente a sí mismo**

* **Mismo código.** Reproduce el camino real: `technical_signals` → `fuse_signals`
  → `evaluate_net_ev` → `RiskSentinel`. No hay una copia de la estrategia que
  pueda divergir de la que opera. Los resultados se escriben en el mismo esquema
  SQLite, así que `compute_metrics` produce las mismas métricas que en vivo.
* **Sin lookahead.** En la barra *i* la estrategia ve `bars[:i+1]` y nada más.
* **Orden intrabarra pesimista.** Si una barra toca el stop y el objetivo, se
  asume que ejecutó el stop.
* **Costos siempre cobrados**, y el spread se contabiliza como costo explícito en
  vez de esconderse dentro del precio de ejecución — si no, `fees / P&L bruto`
  saldría bonito y falso.
* **Sin sentimiento.** El sentimiento histórico de noticias no es reproducible
  después del hecho; incluirlo inflaría el backtest frente a lo que el bot puede
  saber en vivo.
* **Fuera de muestra.** La calibración corta el historial cronológicamente y
  revalida la mejor combinación en el tramo reservado. Si no se sostiene, lo dice:
  *"trátalo como sobreajuste, no como hallazgo"*.

Un barrido completo (108 combinaciones × ~600 barras × 3 símbolos) toma cerca de
un minuto.

---

## Instalación

```bash
cd trading
python -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # y completa las credenciales
```

Requiere Python 3.11+. El núcleo (indicadores, costos, riesgo, métricas) es
stdlib puro; `pandas`/`numpy` solo hacen falta si quieres analizar la base de
datos por tu cuenta.

### Variables de entorno

Las credenciales se leen del entorno o de `.env` (que está en `.gitignore`).
Nunca van en el código.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` | sí | Credenciales de Alpaca. |
| `ALPACA_BASE_URL` | sí | `https://paper-api.alpaca.markets` (paper) o `https://api.alpaca.markets` (live). |
| `ANTHROPIC_API_KEY` | recomendada | Clasificación de sentimiento. Sin ella se usa un clasificador léxico de respaldo con confianza limitada a 0.35. |
| `NEWS_API_KEY`, `NEWS_PROVIDER` | no | Fuente redundante: `finnhub` o `newsapi`. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | no | Alertas por Telegram. |
| `ALERT_EMAIL`, `SMTP_URL` | no | Alertas por correo (`smtp[s]://usuario:clave@host:puerto`). |
| `DRY_RUN` | no | `true` registra decisiones sin enviar órdenes. |

El resto (universo, límites de riesgo, modelo de costos) está documentado en
`.env.example` con los valores por defecto del piloto.

---

## Paper vs. live

El sistema arranca en paper por defecto. Configura el balance de la cuenta paper
en $30 desde el dashboard de Alpaca para que el experimento sea representativo.

```bash
# Paper (por defecto)
ALPACA_BASE_URL=https://paper-api.alpaca.markets

# Live: solo después de revisar la corrida en paper
ALPACA_BASE_URL=https://api.alpaca.markets
```

`python -m trading_bot check` avisa explícitamente cuando la URL apunta a live, y
`scripts/start_experiment.py` pide una confirmación escrita antes de operar con
dinero real.

---

## Uso

```bash
python -m trading_bot check              # valida configuración y conectividad
python -m trading_bot status             # cuenta, riesgo, posiciones y métricas
python -m trading_bot cycle              # un ciclo de trading y termina
python -m trading_bot news --hours 12    # una pasada de ingesta + clasificación
python -m trading_bot learn              # ciclo de aprendizaje
python -m trading_bot nightly            # cierre completo: aprendizaje + reporte
python -m trading_bot report             # reporte del día
python -m trading_bot report --final     # reporte final del experimento
python -m trading_bot dashboard          # regenera reports/dashboard.html
python -m trading_bot backtest           # simula la estrategia sobre historial
python -m trading_bot calibrate          # barrido de parámetros con validación
python -m trading_bot run                # scheduler 24/7
```

Controles manuales:

```bash
python -m trading_bot kill-switch on --reason "revisión manual"
python -m trading_bot kill-switch off
python -m trading_bot flatten            # cancela órdenes y cierra posiciones
```

Las opciones globales van **antes** del subcomando:
`python -m trading_bot --env-file .env.prod --json status`.

### Arrancar el experimento de 30 días

```bash
python scripts/start_experiment.py --check-only   # verificación previa
python scripts/start_experiment.py                # marca el día 0 y arranca
```

Marca la fecha de inicio, guarda la configuración usada para el reporte final y
deja corriendo el scheduler. El estado vive en SQLite: si el proceso se reinicia,
el experimento continúa donde estaba.

---

## Operación 24/7

El scheduler ejecuta trabajos distintos según la sesión de mercado:

| Sesión | Qué corre |
|---|---|
| Mercado abierto | Ciclo de trading completo cada `TRADE_INTERVAL_MINUTES`, noticias, heartbeat. |
| Pre / post-market | Noticias y monitoreo. **Sin ejecución**: Alpaca rechaza órdenes fraccionarias fuera de horario. |
| Mercado cerrado | Ingesta de noticias y, tras el cierre, el ciclo nocturno de aprendizaje y el reporte diario. |

Usa APScheduler si está instalado; si no, un loop de la biblioteca estándar con
los mismos trabajos.

**Protecciones activas**

* Circuit breaker: tras `CONSECUTIVE_ERROR_LIMIT` fallos consecutivos pausa la
  operación con enfriamiento, y avisa.
* Límite de pérdida diaria: detiene las entradas por el resto del día.
* Límite de drawdown: **activa el kill switch**; no se reanuda solo.
* Kill switch manual y automático, persistido en la base de datos.
* Órdenes sin ejecutar se cancelan tras 20 minutos.

**Logging.** Cada decisión se escribe como una línea JSON en `LOG_FILE`, con las
señales, la evaluación de EV y el motivo del rechazo si lo hubo:

```bash
tail -f logs/trading_bot.jsonl | python -m json.tool
```

---

## Métricas y reportes

Diario y acumulado: P&L neto, retorno sobre capital inicial, win rate, número de
trades, fees totales, **ratio fees / P&L bruto** (la métrica crítica con $30),
Sharpe simplificado, drawdown máximo y comparación contra SPY buy-and-hold.

El reporte final (día 30) resume qué señales funcionaron y cuáles no, y emite una
recomendación **continuar / ajustar / detener** fundamentada en esos números.

El dashboard (`reports/dashboard.html`) es un archivo HTML autocontenido, sin
dependencias externas: ábrelo en el navegador para revisar resultados sin leer
logs crudos.

---

## Base de datos

SQLite para el piloto (`DATABASE_URL`), con un esquema que migra a Postgres sin
cambios de fondo. Tablas: `news_items`, `sentiment_scores`, `decisions`,
`orders`, `trades`, `signal_weights`, `equity_snapshots`, `daily_metrics`,
`events`, `state`.

Cada orden apunta a la decisión que la originó, y cada decisión guarda las
señales y el cálculo de EV que la justificaron: toda operación es auditable
después del hecho.

```bash
sqlite3 data/trading_bot.db "SELECT trading_day, symbol, action, approved, reason FROM decisions ORDER BY id DESC LIMIT 20;"
```

---

## Tests

```bash
pytest
```

La cobertura se concentra donde un error cuesta dinero: cálculo de EV neto,
modelo de fees, dimensionamiento de posición, límites duros y reglas PDT.

---

## Despliegue con Docker

```bash
docker compose up -d --build
docker compose logs -f
```

`data/`, `logs/` y `reports/` se montan como volúmenes: el contenedor es
desechable, el historial del experimento no.

---

## Estructura

```
trading/
├── src/trading_bot/
│   ├── agents/          news_pulse · trader_core · risk_sentinel · learning_loop
│   ├── brokers/         adaptador de Alpaca + tipos neutrales de broker
│   ├── db/              esquema SQL y capa de persistencia
│   ├── signals/         indicadores técnicos y fusión ponderada
│   ├── marketdata/      proveedores de precios (Alpaca · Polygon · Alpha Vantage)
│   ├── backtest/        simulación histórica y calibración de parámetros
│   ├── costs.py         modelo de fees y valor esperado neto
│   ├── metrics.py       métricas de desempeño
│   ├── reporting.py     reportes y dashboard HTML
│   ├── engine.py        composición de los agentes
│   ├── scheduler.py     operación 24/7 por sesión
│   ├── circuit_breaker.py · alerts.py · clock.py · config.py · logging_setup.py
│   └── cli.py
├── scripts/start_experiment.py
├── tests/
└── Dockerfile · docker-compose.yml · .env.example
```

---

## Límites del sistema (no negociables)

1. Kill switch manual y automático (drawdown / pérdida diaria).
2. Nunca opera más allá del capital asignado al experimento.
3. Todo trade queda registrado con su justificación **antes** de ejecutarse.
4. Solo órdenes limit: con $30, el slippage de una orden market se come el edge.
5. Sin posiciones cortas mientras `shorting_enabled` sea falso en la cuenta.

## Advertencias honestas sobre el piloto

* Con $30, el costo fijo del viaje de ida y vuelta domina. Es esperable que el
  bot rechace la mayoría de los candidatos: eso es el sistema funcionando, no
  fallando.
* Las tasas de fees regulatorios cambian periódicamente. Verifica
  `SEC_FEE_RATE` y `TAF_PER_SHARE` contra las tablas vigentes antes de operar
  live.
* Con pocos trades cerrados, el ciclo de aprendizaje ajusta pesos sobre muestras
  muy pequeñas. El reporte final lo señala explícitamente cuando ocurre.
* **Corre `backtest` y `calibrate` antes de arrancar los 30 días.** Un backtest
  favorable no es una promesa, pero uno desfavorable sí es una advertencia: si la
  estrategia no cubre sus costos sobre años de historial, tampoco lo hará en 30
  días con $30.
