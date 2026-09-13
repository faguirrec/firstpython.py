# Despliegue 24/7

El bot está diseñado para correr sin supervisión. Este documento cubre dónde
alojarlo, cómo ajustarlo al horario del mercado que operes, y qué vigilar.

> Antes de desplegar nada: `trading-bot simulate` valida el ambiente completo sin
> credenciales, y `trading-bot backtest` dice si la estrategia tiene edge. Un
> despliegue impecable de una estrategia sin edge sigue perdiendo dinero.

---

## 1. Qué plataforma

Requisitos reales del bot: un proceso siempre encendido, ~200 MB de RAM, un disco
persistente pequeño para SQLite, y **una sola instancia** (dos schedulers sobre
la misma cuenta de Alpaca duplican órdenes).

| Opción | Costo aprox. | Cuándo elegirla |
|---|---|---|
| **Fly.io** | ~US$2–5/mes (máquina `shared-cpu-1x` 512 MB + volumen 1 GB) | La más barata para un proceso siempre encendido. Ya incluida como `fly.toml`. |
| **Render** | desde ~US$7/mes (plan Starter) | Si prefieres despliegue por git-push y un dashboard simple. `render.yaml` incluido. El plan gratuito **no sirve**: se duerme por inactividad, y un bot dormido no gestiona sus salidas. |
| **VPS propio** (Hetzner, DigitalOcean) | US$4–6/mes | Control total, y el más predecible en costo. `deploy/trading-bot.service` incluido. |
| **Tu computador** | US$0 | Solo para pruebas. Si se apaga, el bot deja de gestionar posiciones abiertas. |

**Recomendación:** Fly.io para empezar. Con $30 de capital, la infraestructura no
debería costar más que el experimento.

Una advertencia sobre plataformas serverless o cron-only (GitHub Actions, Lambda,
Cloud Run con escala a cero): **no sirven para esto**. El bot mantiene estado
entre ciclos, necesita gestionar salidas de posiciones abiertas en cualquier
momento del horario de mercado, y una ejecución que arranca en frío cada vez
pierde la reconciliación de órdenes.

### Fly.io

```bash
cd trading
fly launch --no-deploy --name mi-trading-bot
fly volumes create trading_data --size 1 --region scl
fly secrets set \
  ALPACA_API_KEY=... \
  ALPACA_SECRET_KEY=... \
  ANTHROPIC_API_KEY=... \
  HEALTH_TOKEN="$(openssl rand -hex 24)" \
  TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...
fly deploy
fly logs
```

`fly.toml` ya fija `auto_stop_machines = false` y `min_machines_running = 1`: el
bot nunca debe escalar a cero ni levantar una segunda instancia.

### Render

Conecta el repo, apunta a `trading/render.yaml`, y define los secretos en el
dashboard (`sync: false` en el YAML significa exactamente eso: Render los pide,
no viajan en el repo).

### VPS con Docker

```bash
git clone <repo> /opt/trading-bot && cd /opt/trading-bot/trading
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f
```

### VPS sin Docker (systemd)

```bash
sudo useradd --system --create-home trader
sudo git clone <repo> /opt/trading-bot
cd /opt/trading-bot/trading
sudo -u trader python3 -m venv .venv
sudo -u trader .venv/bin/pip install -r requirements.txt -e .
sudo -u trader cp .env.example .env && sudo -u trader nano .env
sudo cp deploy/trading-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now trading-bot
journalctl -u trading-bot -f
```

---

## 2. Horario del mercado

El scheduler deriva **todas** sus ventanas del calendario configurado: cuándo
opera, cuándo solo monitorea, y a qué hora corre el cierre nocturno.

```bash
trading-bot calendar --list     # perfiles disponibles
trading-bot calendar            # el configurado, con sesión actual y próxima apertura
```

```
EXCHANGE=XNYS    # NYSE/Nasdaq 09:30–16:00 ET (el único operable vía Alpaca)
EXCHANGE=XLON    # Londres 08:00–16:30
EXCHANGE=XETR    # Frankfurt 09:00–17:30
EXCHANGE=XTKS    # Tokio 09:00–11:30 y 12:30–15:30 (con pausa de almuerzo)
EXCHANGE=XHKG    # Hong Kong 09:30–12:00 y 13:00–16:00
```

Los feriados de EE.UU. **se calculan por regla**, no de una tabla: Viernes Santo
se deriva de la Pascua, y los feriados en sábado/domingo se corren como lo hace
NYSE. El calendario no expira. Los cierres extraordinarios (duelo nacional,
huracanes) y los cierres tempranos no están modelados: para esos, el calendario
de Alpaca sigue siendo la autoridad y el bot lo consulta cuando puede.

### Un mercado que no está en la lista

```json
{
  "code": "XSGO",
  "name": "Bolsa de Santiago",
  "timezone": "America/Santiago",
  "regular": [["09:30", "16:00"]],
  "holidays": ["2026-09-18", "2026-09-19"],
  "currency": "CLP"
}
```

```
EXCHANGE_CALENDAR_FILE=/app/data/calendario.json
```

Durante una pausa intradía (el almuerzo en Tokio o Hong Kong) el bot monitorea y
clasifica noticias, pero **no ejecuta**. Verifica los horarios contra la bolsa
antes de confiar en un perfil que no sea XNYS: Alpaca solo opera acciones de
EE.UU., así que los demás perfiles existen para que las ventanas de monitoreo y
los reportes sean correctos si algún día el broker los soporta.

---

## 3. Monitoreo

Con `HEALTH_PORT` definido, el bot expone dos endpoints:

| Endpoint | Autenticación | Qué devuelve |
|---|---|---|
| `GET /health` | ninguna | `200` si el scheduler está vivo; `503` si se detuvo, el kill switch está activo o el circuit breaker abierto. **No expone cifras de la cuenta.** |
| `GET /status` | `Authorization: Bearer $HEALTH_TOKEN` | Estado completo: equity, posiciones, límites, métricas. |

`/status` se niega a responder si no configuraste `HEALTH_TOKEN`: el equity y las
posiciones no deben quedar legibles para cualquiera que encuentre la URL.

Apunta un monitor de uptime gratuito (UptimeRobot, Better Stack) a `/health` y
tendrás aviso si el bot muere. Es la pieza que falta cuando algo corre solo:
el bot no puede avisarte de su propia muerte.

```bash
curl -s https://mi-bot.fly.dev/health | python -m json.tool
curl -s -H "Authorization: Bearer $HEALTH_TOKEN" https://mi-bot.fly.dev/status | python -m json.tool
```

Desde la línea de comandos:

```bash
trading-bot status              # estado completo
trading-bot status --strict     # además: código de salida ≠ 0 si algo está mal
trading-bot report              # resumen del día
trading-bot dashboard           # regenera reports/dashboard.html
```

`status --strict` es lo que usa el `HEALTHCHECK` de Docker. Falla cuando el
broker es inalcanzable, el kill switch está activo, el breaker abierto, o el
scheduler lleva dos intervalos sin latir.

---

## 4. Operación diaria

**Alertas.** Configura `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID` (o
`ALERT_EMAIL` + `SMTP_URL`). Recibirás el resumen diario, y los avisos de límite
de pérdida, drawdown y circuit breaker escalado.

**Freno de mano**, desde cualquier parte:

```bash
fly ssh console -C "python -m trading_bot kill-switch on --reason 'revisión'"
fly ssh console -C "python -m trading_bot flatten --yes"
```

El kill switch bloquea **entradas nuevas**; las salidas siguen operando. Eso es
deliberado: el peor momento para dejar de gestionar una posición perdedora es
justo cuando algo se disparó.

**Respaldos.** El experimento entero vive en SQLite. Si pierdes el volumen,
pierdes el historial:

```bash
fly ssh sftp get /data/trading_bot.db ./backup-$(date +%F).db
```

---

## 5. Lo que puede salir mal y cómo lo maneja

| Situación | Comportamiento |
|---|---|
| API de Alpaca caída | Reintentos con backoff exponencial; tras N fallos consecutivos el circuit breaker abre y pausa **entradas**. Las salidas siguen. |
| Fallos repetidos del breaker | Tras 4 aperturas activa el kill switch y alerta: una dependencia que no vuelve sola es problema de un humano. |
| Rate limit (429) | Throttle propio por debajo del límite de Alpaca. Un ciclo donde ningún símbolo dio datos cuenta como fallo, así que el breaker sí se entera. |
| El proceso muere con una orden en vuelo | La orden se registra con un `client_order_id` derivado de la fila local; al arrancar se reconcilia contra el broker y se adopta o se retira. |
| Fill parcial | Se contabiliza la porción llenada; la posición existe y tiene stop. Un fill parcial que luego expira **no** se pierde. |
| Reinicio después del cierre | El cierre nocturno no se repite: queda registrado en la base de datos. |
| Disco lleno / volumen no escribible | Falla al arrancar con un mensaje claro y código 2, en vez de entrar en bucle de reinicio. |
| Dos instancias por error | **No está resuelto en el código.** Mantén `numInstances: 1` / `min_machines_running = 1` y no corras `trading-bot cycle` a mano mientras el scheduler está activo. |

---

## 6. Antes de poner dinero real

```bash
trading-bot simulate --days 5          # ambiente: 20 verificaciones
trading-bot simulate --outage-rate 0.2 # resiliencia ante fallos del broker
trading-bot backtest --timeframe 1Day --limit 750
trading-bot calibrate
trading-bot check                      # configuración y conectividad
```

Y una última verificación manual: que `ALPACA_BASE_URL` siga apuntando a paper.
`trading-bot check` lo dice en su salida, y `scripts/start_experiment.py` exige
confirmación escrita para operar en live.
