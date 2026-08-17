import { Router } from 'express';
import { z } from 'zod';
import { env } from '../lib/env.js';
import { correoConfigurado } from '../services/mailer.js';
import { enviarReportesMensuales, mesPasado } from '../services/reporteMensual.js';

export const tareasRouter = Router();

/**
 * Tareas programadas, disparadas desde fuera.
 *
 * Existe además un temporizador dentro del servidor, pero no basta: en los
 * planes que suspenden la máquina cuando nadie la usa, el proceso no está vivo
 * a la hora señalada. Una petición externa la despierta y ejecuta la tarea.
 *
 * Protegida por una clave compartida en la cabecera, no por sesión de usuario,
 * porque quien llama es un cron y no una persona.
 */
tareasRouter.post('/reporte-mensual', async (req, res) => {
  if (!env.cronSecret) {
    res.status(503).json({ error: 'Las tareas programadas no están habilitadas (falta CRON_SECRET).' });
    return;
  }

  const entregada = req.get('x-cron-secret') ?? '';
  // Comparación de largo constante para no filtrar la clave por tiempos.
  if (!comparacionSegura(entregada, env.cronSecret)) {
    res.status(401).json({ error: 'Clave inválida.' });
    return;
  }

  if (!correoConfigurado()) {
    res.status(503).json({ error: 'El envío de correo no está configurado en el servidor.' });
    return;
  }

  const parsed = z
    .object({ mes: z.string().regex(/^\d{4}-\d{2}$/).optional() })
    .safeParse(req.body ?? {});
  const mes = parsed.success ? (parsed.data.mes ?? mesPasado()) : mesPasado();

  try {
    res.json(await enviarReportesMensuales(mes));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

function comparacionSegura(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i += 1) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}
