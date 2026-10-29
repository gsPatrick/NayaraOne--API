'use strict';

// Apoio das provas de origem e detalhe (M9-D611, M9-D690) dos KPIs da M9-D652 e M9-D653: lê do snapshot gravado a referência de origem assinada de um KPI
// e abre o detalhe paginado como a API abre, devolvendo as linhas, o total do agregado e os ajustes (parcelas fora da tabela de origem).
const e = require('./m9d652Env');
const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
const money = require('../../../src/features/analytics/metrics/formulas/money');

async function sourceRef(env, t, code) {
  const [rows] = await env.admin.query(
    `SELECT s.source_refs FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE d.company_id = :c AND d.metric_code = :code AND s.dimension_key = '' ORDER BY s.revision_no DESC LIMIT 1`, { replacements: { c: t.companyId, code } });
  return rows[0].source_refs[0];
}

/** Todas as páginas do detalhe (página de 2 linhas) do KPI; devolve { rows, aggregate, mode, sum (linhas + ajustes) }. */
async function drill(env, t, code, perms) {
  const ref = await sourceRef(env, t, code);
  const ctx = { ...e.ctxOf(t), permissions: ['analytics:read', 'analytics:drilldown', ...perms] };
  return e.inTx(t, {}, async (tx) => {
    const rows = [];
    let page = 1;
    let body;
    do {
      body = await openDrilldown(ctx, { metricCode: code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, page, pageSize: 2, route: 'teste' }, tx);
      rows.push(...body.rows);
      page += 1;
    } while (page <= body.totalPages);
    const adjustments = (body.aggregate.adjustments || []).map((a) => a.total);
    const lines = body.reconcileMode === 'COUNT' ? String(rows.length) : money.toString(money.sum(rows.map((r) => r.contribution || 0)));
    const sum = body.reconcileMode === 'COUNT' ? lines : money.toString(money.sum([lines, ...adjustments]));
    return { rows, aggregate: body.aggregate, mode: body.reconcileMode, sum, lines };
  });
}

module.exports = { sourceRef, drill };
