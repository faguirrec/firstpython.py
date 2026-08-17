import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './lib/env.js';
import { authRouter } from './routes/auth.js';
import { householdRouter } from './routes/household.js';
import { transactionsRouter } from './routes/transactions.js';
import { financeRouter } from './routes/finance.js';
import { settingsRouter } from './routes/settings.js';
import { gmailRouter } from './routes/gmail.js';
import { tareasRouter } from './routes/tareas.js';
import { correoConfigurado } from './services/mailer.js';
// (enviarReportesMensuales se importa más abajo junto al temporizador)
import { enviarReportesMensuales } from './services/reporteMensual.js';

const app = express();

// Necesario detrás del proxy de Fly.io / Render / un túnel: sin esto req.ip es
// la del proxy y req.protocol siempre 'http', y las cookies seguras se rompen.
if (env.trustProxy) app.set('trust proxy', 1);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors({ origin: env.webOrigin, credentials: true }));

/** Momento en que arrancó este proceso: sirve para saber si ya tomó el cambio. */
const ARRANQUE = new Date().toISOString();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    gmail: env.gmailEnabled,
    correo: correoConfigurado(),
    // Render entrega el commit desplegado; en local no existe.
    version: env.version,
    desde: ARRANQUE,
  });
});

app.use('/api/auth', authRouter);
app.use('/api/household', householdRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/finance', financeRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/gmail', gmailRouter);
app.use('/api/tareas', tareasRouter);

// En producción el servidor también sirve la PWA compilada (web/dist).
const webDist = path.resolve(process.cwd(), '../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

/**
 * Temporizador del reporte mensual.
 *
 * Revisa cada seis horas si corresponde enviarlo. El envío es idempotente
 * —queda registrado por hogar, mes y destinatario— así que revisar de más no
 * duplica nada. Sólo actúa en los primeros días del mes, que es cuando el mes
 * anterior ya cerró.
 *
 * No reemplaza al disparo externo: si el servidor se suspende por inactividad,
 * este temporizador no corre, y ahí entra el cron que golpea /api/tareas.
 */
function programarReporteMensual(): void {
  if (!correoConfigurado()) return;

  const SEIS_HORAS = 6 * 60 * 60 * 1000;
  const revisar = async () => {
    if (new Date().getDate() > 5) return;
    try {
      const resultado = await enviarReportesMensuales();
      if (resultado.enviados > 0) {
        console.log(`Reporte mensual de ${resultado.mes}: ${resultado.enviados} correos enviados.`);
      }
      for (const error of resultado.errores) console.error(`Reporte mensual: ${error}`);
    } catch (err) {
      console.error('Reporte mensual:', (err as Error).message);
    }
  };

  const timer = setInterval(() => void revisar(), SEIS_HORAS);
  timer.unref();
  // Un poco después de arrancar, para no competir con el inicio del servidor.
  setTimeout(() => void revisar(), 60_000).unref();
}

app.listen(env.port, () => {
  console.log(`API escuchando en http://localhost:${env.port}`);
  if (!env.gmailEnabled) {
    console.log('Gmail deshabilitado: define GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET para activarlo.');
  }
  if (!correoConfigurado()) {
    console.log('Correo deshabilitado: define SMTP_HOST para enviar invitaciones y reportes.');
  }
  programarReporteMensual();
});
