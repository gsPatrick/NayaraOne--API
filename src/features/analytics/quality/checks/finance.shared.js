'use strict';

/** M9-D696 — leituras comuns dos checks do Financeiro: a linha mais recente do read model e os instantes da data-base (calendário de São Paulo). */
const sql = require('../quality.sql');
const { financeBounds } = require('../../read-models/financeHealth.dates');

const WINDOW_FOR_BOUNDS = 90; // só as fronteiras de dia e de horizonte são usadas aqui; a janela da inadimplência não entra

/** Linha mais recente do read model da empresa (colunas pedidas, números como texto), ou null. */
async function latestRow(ctx, columns) {
  const cols = columns.map((c) => `"${c}"::text AS "${c}"`).join(', ');
  const [row] = await sql.rows(ctx, `SELECT as_of_date::text AS as_of_date, ${cols} FROM ${sql.tableOf(ctx)} WHERE company_id = :companyId ORDER BY as_of_date DESC LIMIT 1`);
  return row || null;
}

const boundsOf = (asOf) => financeBounds(asOf, WINDOW_FOR_BOUNDS);

module.exports = { latestRow, boundsOf };
