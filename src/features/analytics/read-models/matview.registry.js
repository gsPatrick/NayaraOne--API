'use strict';

/**
 * M9-D698 (3.2) — registro das materialized views do BI. Para agregações pesadas e históricas (séries de 12 a 24 meses, rankings) onde recalcular
 * por agregado não compensa. Cada view declara o nome (analytics.mv_*), as colunas do índice único (exigido pelo REFRESH CONCURRENTLY) e a
 * função SECURITY DEFINER que filtra a leitura pela empresa da sessão (a view não tem RLS e o role de runtime não a lê direto).
 */
const NAME_RE = /^mv_[a-z][a-z0-9_]*$/;
const FN_RE = /^read_mv_[a-z][a-z0-9_]*$/;

const views = new Map();

function registerMaterializedView(def) {
  if (!def || typeof def.name !== 'string' || !NAME_RE.test(def.name)) throw new Error('Materialized view do BI: o nome deve seguir mv_nome_em_snake.');
  if (!Array.isArray(def.uniqueColumns) || !def.uniqueColumns.length) throw new Error(`Materialized view ${def.name}: informe as colunas do índice único (exigido pelo refresh concorrente).`);
  if (def.readFunction != null && !FN_RE.test(def.readFunction)) throw new Error(`Materialized view ${def.name}: a função de leitura deve seguir read_mv_nome.`);
  if (views.has(def.name)) throw new Error(`Materialized view duplicada: ${def.name}.`);
  views.set(def.name, Object.freeze({ version: 1, ...def }));
  return views.get(def.name);
}

const unregisterMaterializedView = (name) => views.delete(name);
const getMaterializedView = (name) => views.get(name) || null;
const listMaterializedViews = () => [...views.values()];

module.exports = { registerMaterializedView, unregisterMaterializedView, getMaterializedView, listMaterializedViews };
