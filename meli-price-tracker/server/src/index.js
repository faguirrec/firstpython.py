import { createApp } from './app.js';
import { openDb } from './db.js';

const salt = process.env.CLIENT_SALT;
if (!salt && process.env.NODE_ENV === 'production') {
  console.error('Falta CLIENT_SALT (fly secrets set CLIENT_SALT=...)');
  process.exit(1);
}
const db = openDb(process.env.DB_PATH || './data/prices.db');
const app = createApp(db, { salt: salt || 'dev-only-salt' });
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`meli-price-tracker-server escuchando en :${port}`));
