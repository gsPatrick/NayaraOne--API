'use strict';

/**
 * M9-D696 — consultas dos checks. Cada check recebe `ctx` ({ table, scope, transaction, ... }) e lê SÓ o schema analytics (o read model, ou a
 * tabela sombra do rebuild) e a fonte sob a mesma RLS da transação. O nome da tabela é validado como identificador antes de entrar no SQL;
 * os valores sempre por parâmetro (`:companyId` está sempre disponível).
 */
const { sequelize } = require('../../../models');

const TABLE_RE = /^rm_[a-z][a-z0-9_]*$/;

function tableOf(ctx) {
  if (!TABLE_RE.test(ctx.table || '')) throw new Error(`Tabela de read model inválida para o check: ${ctx.table}`);
  return `analytics."${ctx.table}"`;
}

async function rows(ctx, sql, replacements = {}) {
  const [result] = await sequelize.query(sql, { replacements: { companyId: ctx.scope.companyId, ...replacements }, transaction: ctx.transaction });
  return result;
}

/** Primeira coluna `v` da primeira linha (texto), ou null. */
async function value(ctx, sql, replacements) {
  const [row] = await rows(ctx, sql, replacements);
  return row && row.v !== undefined && row.v !== null ? String(row.v) : null;
}

/** Inteiro da coluna `n` (count). */
async function count(ctx, sql, replacements) {
  const [row] = await rows(ctx, sql, replacements);
  return row ? Number(row.n) : 0;
}

/** Linhas repetidas do read model pela chave de negócio (colunas informadas): soma de (ocorrências - 1). */
async function duplicates(ctx, keyColumns) {
  const cols = keyColumns.map((c) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`Coluna inválida: ${c}`);
    return `"${c}"`;
  }).join(', ');
  const n = await count(ctx, `SELECT COALESCE(SUM(c - 1), 0)::int AS n FROM (SELECT count(*) AS c FROM ${tableOf(ctx)} WHERE company_id = :companyId GROUP BY ${cols} HAVING count(*) > 1) d`);
  return { duplicates: n, keyColumns };
}

/**
 * Eventos aplicados mais de uma vez ao read model: o mesmo `source_event_id` com a caixa ou os espaços diferentes passa pela PK do
 * rm_applied_events (que compara o texto) mas é o mesmo evento. Soma de (ocorrências - 1) por identificador normalizado.
 */
async function duplicateAppliedEvents(ctx) {
  const n = await count(ctx,
    `SELECT COALESCE(SUM(c - 1), 0)::int AS n FROM (SELECT count(*) AS c FROM analytics.rm_applied_events
      WHERE company_id = :companyId AND read_model = :model GROUP BY lower(btrim(source_event_id)) HAVING count(*) > 1) d`, { model: ctx.readModel });
  return { duplicates: n, source: 'rm_applied_events' };
}

module.exports = { tableOf, rows, value, count, duplicates, duplicateAppliedEvents };
