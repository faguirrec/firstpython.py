import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, type Category, type Transaction } from '../lib/api';
import { useSession } from '../lib/session';
import { diaLargo, money, monthLabel } from '../lib/format';
import { cambiarMes, useMes } from '../lib/mes';
import { useVersionDatos } from '../lib/datos';
import Cabecera from '../components/Cabecera';
import NuevoMovimiento from '../components/NuevoMovimiento';
import Sheet from '../components/Sheet';
import { FichaCategoria } from '../components/Fichas';

export default function Movimientos() {
  const { household } = useSession();
  const currency = household?.currency ?? 'CLP';
  const [params, setParams] = useSearchParams();
  const onlyPending = params.get('pendientes') === '1';

  const mesCompartido = useMes();
  /*
   * Los filtros viven en la URL y no en estado local.
   *
   * Es lo que permite entrar acá desde una barra del desglose con la categoría
   * ya puesta. De paso arregla dos cosas que se sentían rotas: el botón de
   * volver del teléfono deshace el filtro en vez de sacarte de la pantalla, y
   * la vista se puede compartir o dejar abierta y vuelve igual.
   */
  const categoryId = params.get('categoria') ?? '';
  const scope = params.get('ambito') ?? '';
  const sinFijos = params.get('sinfijos') === '1';
  /*
   * `mes=todos` es el historial completo, que es lo que muestra el desglose
   * acumulado de Análisis. Sin el parámetro manda el mes compartido entre
   * pantallas, que es el caso normal.
   */
  const todosLosMeses = params.get('mes') === 'todos';
  const month = mesCompartido;
  // Sube cuando se anota algo desde el botón flotante, que vive fuera de acá.
  const version = useVersionDatos();
  const [search, setSearch] = useState('');

  /** Cambia un filtro dejando los demás donde estaban. */
  const ponerFiltro = useCallback((cambios: Record<string, string | null>) => {
    setParams((antes) => {
      const next = new URLSearchParams(antes);
      for (const [k, v] of Object.entries(cambios)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }, [setParams]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rows, setRows] = useState<Transaction[]>([]);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [detail, setDetail] = useState<Transaction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const mes = onlyPending || todosLosMeses ? undefined : month;
      const data = await api.transactions({
        month: mes,
        pending: onlyPending ? '1' : undefined,
        search: search || undefined,
        scope: scope || undefined,
        categoryId: categoryId || undefined,
        // Sólo tiene sentido con un mes: los fijos se pagan mes a mes.
        excluirFijos: sinFijos && mes ? '1' : undefined,
        limit: 300,
      });
      setRows(data.transactions);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [month, search, scope, categoryId, onlyPending, todosLosMeses, sinFijos, version]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void api.categories().then((c) => setCategories(c.categories));
  }, []);

  /*
   * Traer a la vista la ficha de la categoría que está puesta.
   *
   * Al entrar desde una barra del desglose, la ficha marcada suele quedar fuera
   * de la tira —hay doce categorías y caben tres—, así que la fila se veía sin
   * nada elegido justo cuando sí había un filtro. Se mueve sólo la tira, no la
   * página: `block: 'nearest'` evita que el teléfono salte al hacer scroll.
   */
  const tiraCategorias = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!categoryId || !tiraCategorias.current) return;
    const activa = tiraCategorias.current.querySelector('.filtro-chip.activo');
    activa?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [categoryId, categories.length]);

  const total = rows.filter((r) => r.type === 'gasto').reduce((a, b) => a + b.amount, 0);

  /* Cómo se llama lo que se está viendo, para poder decirlo y no sólo pintarlo
     de verde en una ficha a media pantalla de distancia. */
  const categoriaVista = categoryId
    ? categoryId === 'sin'
      ? { name: 'Sin categoría', emoji: '❓' }
      : categories.find((c) => c.id === categoryId) ?? null
    : null;

  /*
   * La lista, partida por día.
   *
   * Una lista corrida de cien filas obliga a leer la fecha de cada una para
   * ubicarse. Agrupada, el día se dice una sola vez y de paso aparece el
   * subtotal, que es la pregunta que uno se hace mirando un día: "¿cuánto
   * gastamos el sábado?".
   *
   * El servidor ya devuelve ordenado por fecha, así que basta con recorrer y
   * cortar cuando cambia el día.
   */
  const porDia: { dia: string; movimientos: Transaction[]; total: number }[] = [];
  for (const t of rows) {
    const ultimo = porDia[porDia.length - 1];
    const grupo = ultimo?.dia === t.occurredOn ? ultimo : null;
    if (grupo) {
      grupo.movimientos.push(t);
      if (t.type === 'gasto') grupo.total += t.amount;
    } else {
      porDia.push({ dia: t.occurredOn, movimientos: [t], total: t.type === 'gasto' ? t.amount : 0 });
    }
  }

  async function quickCategory(transaction: Transaction, newCategoryId: string) {
    await api.updateTransaction(transaction.id, { categoryId: newCategoryId, reviewed: true });
    await load();
    setDetail(null);
  }

  async function remove(transaction: Transaction) {
    if (!confirm(`¿Borrar "${transaction.merchant ?? transaction.description ?? 'este movimiento'}"?`)) return;
    await api.deleteTransaction(transaction.id);
    setDetail(null);
    await load();
  }

  return (
    <>
      <Cabecera
        hogar={onlyPending ? 'Pendientes de revisar' : 'Movimientos'}
        month={onlyPending ? undefined : month}
        onMonthChange={onlyPending ? undefined : cambiarMes}
      />

      {onlyPending && (
        <div className="card">
          <div className="row">
            <span className="muted">Mostrando sólo lo importado desde Gmail sin revisar.</span>
            <div className="wrap">
              <button
                className="small"
                onClick={async () => {
                  await api.reviewAll();
                  await load();
                }}
              >
                Marcar todo revisado
              </button>
              <button className="small ghost" onClick={() => setParams({})}>Ver todos</button>
            </div>
          </div>
        </div>
      )}

      {/*
        * Los filtros como fichas y no como menús desplegables.
        *
        * Un desplegable esconde las opciones y esconde también cuál está
        * puesta: había que abrirlo para saber si estabas viendo todo o sólo lo
        * común. Acá se ve de un vistazo lo que hay y lo que está elegido, y
        * cambiarlo es un toque en vez de tres.
        */}
      <div className="card filtros">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar comercio o nota"
          type="search"
          aria-label="Buscar movimientos"
        />

        <div className="chips-fila" role="group" aria-label="Filtrar por tipo">
          <button
            className={`filtro-chip ${!scope && !onlyPending ? 'activo' : ''}`}
            onClick={() => setParams({}, { replace: true })}
          >
            Todos
          </button>
          <button
            className={`filtro-chip ${onlyPending ? 'activo' : ''}`}
            onClick={() => setParams(onlyPending ? {} : { pendientes: '1' }, { replace: true })}
          >
            Por revisar
          </button>
          <button
            className={`filtro-chip ${scope === 'comun' ? 'activo' : ''}`}
            onClick={() => ponerFiltro({ ambito: scope === 'comun' ? null : 'comun' })}
          >
            Comunes
          </button>
          <button
            className={`filtro-chip ${scope === 'personal' ? 'activo' : ''}`}
            onClick={() => ponerFiltro({ ambito: scope === 'personal' ? null : 'personal' })}
          >
            Personales
          </button>
        </div>

        <div className="chips-fila" role="group" aria-label="Filtrar por categoría" ref={tiraCategorias}>
          <button
            className={`filtro-chip ${!categoryId ? 'activo' : ''}`}
            onClick={() => ponerFiltro({ categoria: null })}
          >
            Todas
          </button>
          {/* Los que no tienen categoría son los que hay que ir a arreglar, así
              que se pueden pedir como cualquier otra. */}
          <button
            className={`filtro-chip ${categoryId === 'sin' ? 'activo' : ''}`}
            onClick={() => ponerFiltro({ categoria: categoryId === 'sin' ? null : 'sin' })}
          >
            <span aria-hidden="true">❓</span> Sin categoría
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              className={`filtro-chip ${categoryId === c.id ? 'activo' : ''}`}
              onClick={() => ponerFiltro({ categoria: categoryId === c.id ? null : c.id })}
            >
              <span aria-hidden="true">{c.emoji}</span> {c.name}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {/*
        * Al entrar desde una barra del desglose, decir en qué se entró.
        *
        * La ficha verde entre veinte fichas no alcanza: se llega acá desde otra
        * pantalla y hay que saber de inmediato por qué la lista está corta, y
        * cómo salir. El recorte se dice completo —el mes, el ámbito, los fijos
        * afuera— porque es lo que explica que el total sea el que es.
        */}
      {categoriaVista && (
        <div className="card viendo">
          <div className="row">
            <span className="quien">
              <FichaCategoria emoji={categoriaVista.emoji} color={('color' in categoriaVista ? categoriaVista.color : null) ?? null} size={30} />
              <span>
                <strong>{categoriaVista.name}</strong>
                <span className="meta">
                  {todosLosMeses ? 'Todo el historial' : monthLabel(month)}
                  {scope === 'comun' && ' · sólo comunes'}
                  {scope === 'personal' && ' · sólo personales'}
                  {sinFijos && !todosLosMeses && ' · sin los fijos'}
                </span>
              </span>
            </span>
            <button className="small ghost" onClick={() => setParams({}, { replace: true })}>
              Ver todo
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>{categoriaVista ? `${rows.length} ${rows.length === 1 ? 'movimiento' : 'movimientos'}` : 'Gastos listados'}</h2>
          <strong className="num">{money(total, currency)}</strong>
        </div>

        {rows.length === 0 && <p className="muted">No hay movimientos con estos filtros.</p>}

        {porDia.map((grupo) => (
          <div key={grupo.dia}>
            <div className="dia-cabecera">
              <span>{diaLargo(grupo.dia)}</span>
              {grupo.total > 0 && <span className="num">{money(grupo.total, currency)}</span>}
            </div>

            <div className="list">
              {grupo.movimientos.map((t) => (
                <button
                  key={t.id}
                  className="item ghost fila-movimiento"
                  onClick={() => setDetail(t)}
                >
                  <FichaCategoria emoji={t.categoryEmoji} color={t.categoryColor} />
                  <div className="body">
                    <div className="title">
                      {t.merchant ?? t.description ?? 'Movimiento'}
                      {t.reviewed === 0 && <span className="pill warn" style={{ marginLeft: 6 }}>por revisar</span>}
                    </div>
                    <div className="meta">
                      {/* El día ya lo dice el encabezado del grupo; repetirlo en
                          cada fila sería ruido. Lo que sí importa acá es cuando
                          el mes contable no es el de la fecha. */}
                      {t.period !== t.occurredOn.slice(0, 7) && `Cuenta en ${monthLabel(t.period, true)} · `}
                      {t.categoryName ?? 'Sin categoría'}
                      {t.scope === 'personal' && ' · personal'}
                      {t.type === 'aporte' && ` · aporte de ${t.userName ?? ''}`}
                      {t.fundedBy !== 'oficial' && t.type === 'gasto' && ` · pagó ${t.userName ?? 'uno de los dos'}`}
                      {t.source === 'gmail' && ' · ✉'}
                    </div>
                  </div>
                  <div className="amount">
                    {t.type === 'aporte' ? '+' : ''}
                    {money(t.amount, currency)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {detail && (
        <Sheet title={detail.merchant ?? 'Movimiento'} onClose={() => setDetail(null)}>
          <div className="hero num">{money(detail.amount, currency)}</div>
          <p className="muted" style={{ marginTop: 4 }}>
            {detail.occurredOn} · {detail.type === 'aporte' ? 'aporte' : detail.scope === 'comun' ? 'gasto común' : 'gasto personal'}
            {detail.accountLabel && ` · ${detail.accountLabel}`}
            {detail.installments && ` · ${detail.installments} cuotas`}
          </p>

          {detail.type === 'gasto' && (
            <label className="field">
              <span>Categoría</span>
              <select value={detail.categoryId ?? ''} onChange={(e) => void quickCategory(detail, e.target.value)}>
                <option value="">Sin categoría</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}

          {detail.source === 'gmail' && detail.rawSnippet && (
            <details className="table-view" open>
              <summary>Correo de origen</summary>
              <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{detail.rawSnippet}</p>
            </details>
          )}

          <div className="wrap" style={{ marginTop: 14 }}>
            <button
              className="primary"
              onClick={() => {
                setEditing(detail);
                setDetail(null);
              }}
            >
              Editar
            </button>
            {detail.reviewed === 0 && (
              <button
                onClick={async () => {
                  await api.updateTransaction(detail.id, { reviewed: true });
                  setDetail(null);
                  await load();
                }}
              >
                Marcar revisado
              </button>
            )}
            <button className="danger" onClick={() => void remove(detail)}>Borrar</button>
          </div>
        </Sheet>
      )}

      {editing && (
        <NuevoMovimiento
          month={month}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}
