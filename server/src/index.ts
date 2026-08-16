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

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors({ origin: env.webOrigin, credentials: true }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, gmail: env.gmailEnabled });
});

app.use('/api/auth', authRouter);
app.use('/api/household', householdRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/finance', financeRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/gmail', gmailRouter);

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

app.listen(env.port, () => {
  console.log(`API escuchando en http://localhost:${env.port}`);
  if (!env.gmailEnabled) {
    console.log('Gmail deshabilitado: define GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET para activarlo.');
  }
});
