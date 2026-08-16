import { db } from '../lib/db.js';

/**
 * Devuelve la categoría que corresponde a un comercio según las reglas del hogar.
 * Las reglas son expresiones regulares (case-insensitive) ordenadas por prioridad.
 */
export function categorize(householdId: string, text: string | null): string | null {
  if (!text) return null;

  const rules = db
    .prepare('SELECT pattern, category_id AS categoryId FROM category_rules WHERE household_id = ? ORDER BY priority')
    .all(householdId) as { pattern: string; categoryId: string }[];

  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, 'i').test(text)) return rule.categoryId;
    } catch {
      // Patrón inválido: se ignora esa regla.
    }
  }
  return null;
}

/** Re-aplica las reglas a las transacciones sin categoría. Devuelve cuántas actualizó. */
export function recategorizeUncategorized(householdId: string): number {
  const rows = db
    .prepare(
      `SELECT id, merchant, description FROM transactions
        WHERE household_id = ? AND category_id IS NULL`,
    )
    .all(householdId) as { id: string; merchant: string | null; description: string | null }[];

  const update = db.prepare('UPDATE transactions SET category_id = ? WHERE id = ?');
  let changed = 0;

  for (const row of rows) {
    const categoryId = categorize(householdId, `${row.merchant ?? ''} ${row.description ?? ''}`);
    if (categoryId) {
      update.run(categoryId, row.id);
      changed += 1;
    }
  }
  return changed;
}
