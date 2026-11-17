'use strict';

/**
 * M9-D690 (3.3, 3.5) — uma página das linhas-fonte do filtro assinado: id, campos de negócio, link da tela do registro e contribuição
 * para o total. O WHERE vem de `buildWhere` (M9-D611: identificadores da especificação, valores por parâmetro). A contribuição é o valor
 * do campo monetário com o sinal da origem (modo SUM), 1 (modo COUNT) ou nula (modo RECOMPUTE: as linhas alimentam a fórmula do KPI).
 */
const { sequelize } = require('../../../models');
const { buildWhere, countAndSum } = require('./sourceRefs.query');
const { detailOf } = require('./drilldown.details');
const money = require('./formulas/money');

const from = (spec) => `FROM ${spec.table.split('.').map((p) => `"${p}"`).join('.')} t`;

function contributionSql(spec, mode) {
  if (mode === 'COUNT') return "'1'";
  if (mode !== 'SUM' || !spec.valueColumn) return 'NULL';
  const sign = spec.valueSign;
  const value = `t."${spec.valueColumn}"`;
  return sign ? `(CASE WHEN t."${sign.column}" IN (:negatives) THEN -${value} ELSE ${value} END)::text` : `${value}::text`;
}

/** { rows: [{ id, fields, contribution, link }], total } da página pedida (página 1 é a primeira). */
async function pageRows(spec, filter, { mode, page, pageSize }, transaction) {
  const { where, replacements } = buildWhere(spec, filter);
  const { columns, link } = detailOf(spec);
  const select = [`t."${spec.idColumn}"::text AS "__id"`, `${contributionSql(spec, mode)} AS "__contribution"`, ...columns.map((c) => `t."${c}" AS "f_${c}"`)];
  const sign = spec.valueSign;
  const [rows] = await sequelize.query(
    `SELECT ${select.join(', ')} ${from(spec)} WHERE ${where} ORDER BY t."${spec.idColumn}" LIMIT :limit OFFSET :offset`,
    { replacements: { ...replacements, ...(sign ? { negatives: sign.negative } : {}), limit: pageSize, offset: (page - 1) * pageSize }, transaction }
  );
  return {
    rows: rows.map((r) => ({
      id: r.__id,
      fields: Object.fromEntries(columns.map((c) => [c, r[`f_${c}`]])),
      contribution: r.__contribution,
      link: link ? link.replace('{id}', r.__id) : null,
    })),
  };
}

/**
 * Agregado permitido (sem linhas): contagem e, nas origens monetárias, o total no sinal da origem; nas demais, total nulo. Origem com parcelas fora da
 * tabela (`addends`, M9-D620: saldo de abertura e transferências do caixa livre) traz também `adjustments` [{ label, total }]: linhas + ajustes = total.
 * Uma varredura só para contagem e soma (`countAndSum`), e as parcelas lidas uma vez: antes a contagem, a soma e as parcelas eram consultas separadas
 * sobre as mesmas linhas (e as parcelas, duas vezes).
 */
async function aggregateOf(spec, filter, transaction) {
  const { count, total, adjustments } = await countAndSum(spec, filter, transaction);
  const adj = spec.addends && spec.valueColumn ? adjustments.map((a) => ({ label: a.label, total: money.money(a.total) })) : [];
  return adj.length ? { count, total: money.money(total), adjustments: adj } : { count, total: total === null ? null : money.money(total) };
}

module.exports = { pageRows, aggregateOf };
