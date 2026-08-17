import type { NextFunction, Request, Response } from 'express';

type Bucket = { count: number; resetAt: number };

/**
 * Límite de intentos en memoria, pensado para una app de dos personas expuesta
 * a internet: frena la fuerza bruta contra el login sin agregar dependencias ni
 * un Redis. Al reiniciar el servidor los contadores se pierden, lo que es
 * aceptable en este tamaño.
 */
export function rateLimit(options: {
  windowMs: number;
  max: number;
  message: string;
  /** Si es true, una petición que sale bien devuelve el intento al cupo. */
  refundOnSuccess?: boolean;
}) {
  const buckets = new Map<string, Bucket>();

  // Poda periódica para que el mapa no crezca sin control.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, options.windowMs);
  timer.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'desconocido';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.max) {
      const seconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.status(429).json({ error: `${options.message} Reintenta en ${Math.ceil(seconds / 60)} minutos.` });
      return;
    }

    // Así el cupo lo consumen sólo los fallos: entrar bien nunca te deja fuera.
    if (options.refundOnSuccess) {
      res.on('finish', () => {
        if (res.statusCode < 400) bucket.count = Math.max(0, bucket.count - 1);
      });
    }

    next();
  };
}
