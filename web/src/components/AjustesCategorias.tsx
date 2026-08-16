import { useEffect, useState } from 'react';
import { api, type Category, type CategoryRule } from '../lib/api';

const PRESET_COLORS = ['#4f46e5', '#0891b2', '#0d9488', '#16a34a', '#ca8a04', '#dc2626', '#ea580c', '#db2777', '#7c3aed', '#6b7280'];

export default function AjustesCategorias() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<CategoryRule[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('gusto');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [pattern, setPattern] = useState('');
  const [ruleCategory, setRuleCategory] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [c, r] = await Promise.all([api.categories(), api.categoryRules()]);
    setCategories(c.categories);
    setRules(r.rules);
    if (!ruleCategory && c.categories.length > 0) setRuleCategory(c.categories[0].id);
  }

  useEffect(() => {
    void load();
  }, []);

  async function addCategory() {
    if (!name.trim()) return;
    setError(null);
    try {
      await api.createCategory({ name: name.trim(), kind, color });
      setName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function addRule() {
    if (!pattern.trim() || !ruleCategory) return;
    setError(null);
    try {
      await api.createCategoryRule({ pattern: pattern.trim(), categoryId: ruleCategory });
      setPattern('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      {error && <div className="error">{error}</div>}
      {message && <div className="ok">{message}</div>}

      <div className="card">
        <h2>Categorías</h2>
        <div className="list">
          {categories.map((c) => (
            <div className="item" key={c.id}>
              <i className="dot" style={{ background: c.color }} />
              <div className="body">
                <div className="title">{c.name}</div>
                <div className="meta">{c.kind}</div>
              </div>
              <button
                className="small danger ghost"
                onClick={async () => {
                  if (!confirm(`¿Borrar la categoría "${c.name}"? Los movimientos quedan sin categoría.`)) return;
                  await api.deleteCategory(c.id);
                  await load();
                }}
              >
                Borrar
              </button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <label className="field">
            <span>Nueva categoría</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jardín" />
          </label>
          <div className="grid2">
            <label className="field">
              <span>Tipo</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="necesidad">Necesidad</option>
                <option value="gusto">Gusto</option>
                <option value="ahorro">Ahorro</option>
              </select>
            </label>
            <label className="field">
              <span>Color</span>
              <select value={color} onChange={(e) => setColor(e.target.value)}>
                {PRESET_COLORS.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary" onClick={() => void addCategory()}>Agregar categoría</button>
        </div>
      </div>

      <div className="card">
        <h2>Categorización automática</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Cuando el nombre del comercio coincide con el patrón, el movimiento entra ya categorizado. Se pueden usar
          varias alternativas separadas por <code>|</code>.
        </p>

        <div className="list">
          {rules.map((r) => (
            <div className="item" key={r.id}>
              <div className="body">
                <div className="title" style={{ fontFamily: 'ui-monospace, monospace', fontSize: '0.82rem' }}>
                  {r.pattern}
                </div>
                <div className="meta">→ {r.categoryName}</div>
              </div>
              <button
                className="small danger ghost"
                onClick={async () => {
                  await api.deleteCategoryRule(r.id);
                  await load();
                }}
              >
                Borrar
              </button>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14 }}>
          <label className="field">
            <span>Patrón</span>
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="jumbo|lider|unimarc" />
          </label>
          <label className="field">
            <span>Categoría</span>
            <select value={ruleCategory} onChange={(e) => setRuleCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <div className="wrap">
            <button className="primary" onClick={() => void addRule()}>Agregar regla</button>
            <button
              onClick={async () => {
                const result = await api.recategorize();
                setMessage(`${result.updated} movimientos quedaron categorizados.`);
              }}
            >
              Aplicar a lo que no tiene categoría
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
