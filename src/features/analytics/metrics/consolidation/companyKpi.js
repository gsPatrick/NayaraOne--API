'use strict';

/**
 * M9-D625 — valor de UM indicador numa empresa do consolidado, lido do snapshot da empresa (nunca recalculado aqui) sob o contexto de RLS dela e
 * com as permissões que o usuário tem nela. Empresa sem o indicador publicado ou sem registro na data: valor nulo e status INCOMPLETE (o consolidado
 * não soma o que não existe). Devolve também o período do registro (para o corte do fluxo liquidado).
 */
const { sequelize } = require('../../../../models');
const money = require('../formulas/money');
const { readMetricAsOf } = require('../registry.asOf');
const { inCompany } = require('./companyAccess');

const fmt = (unit, value) => (unit === 'COUNT' ? money.count(value) : money.money(value));
const MISSING = new Set(['ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'ANALYTICS_METRIC_NOT_FOUND']);

async function periodOf(metricCode, companyId, asOfDate, revisionNo, transaction) {
  const [rows] = await sequelize.query(
    `SELECT s.period_start::text AS "from", s.period_end::text AS "to" FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
      WHERE d.metric_code = :metricCode AND s.scope_type = 'COMPANY' AND s.scope_id = :companyId AND s.as_of_date = :asOfDate AND s.dimension_key = '' AND s.revision_no = :revisionNo
      ORDER BY s.created_at DESC LIMIT 1`, { replacements: { metricCode, companyId, asOfDate, revisionNo }, transaction });
  return rows[0] || { from: asOfDate, to: asOfDate };
}

async function readOne(company, ctx, metricCode, asOfDate, dimensionKey, transaction) {
  const readCtx = { groupId: ctx.groupId, companyId: company.id, actorUserId: ctx.actorUserId, permissions: company.permissions };
  try {
    return await readMetricAsOf(readCtx, { metricCode, scopeType: 'COMPANY', scopeId: company.id, asOfDate, dimensionKey }, transaction);
  } catch (err) {
    if (MISSING.has(err.code)) return null;
    throw err;
  }
}

/** { companyId, companyName, value, status, unit, asOfDate, sourceSnapshotAt, refreshedAt, period, dimensions } de cada empresa permitida. */
async function readCompanies(ctx, companies, metricCode, asOfDate, dimensionKeys, transaction) {
  const out = [];
  for (const company of companies) {
    const read = await inCompany(company.id, ctx.companyId, transaction, async () => {
      const main = await readOne(company, ctx, metricCode, asOfDate, '', transaction);
      if (!main) return null;
      const dimensions = {};
      for (const key of dimensionKeys) dimensions[key] = (await readOne(company, ctx, metricCode, asOfDate, key, transaction)) || null;
      return { main, dimensions, period: await periodOf(metricCode, company.id, asOfDate, main.revisionNo, transaction) };
    });
    out.push(read ? {
      companyId: company.id, companyName: company.name, value: read.main.value === null ? null : fmt(read.main.unit, read.main.value), status: read.main.status, unit: read.main.unit,
      asOfDate, sourceSnapshotAt: read.main.sourceSnapshotAt, refreshedAt: read.main.refreshedAt, period: read.period, dimensions: read.dimensions,
    } : {
      companyId: company.id, companyName: company.name, value: null, status: 'INCOMPLETE', unit: null, asOfDate, sourceSnapshotAt: null, refreshedAt: null, period: { from: asOfDate, to: asOfDate }, dimensions: {},
    });
  }
  return out;
}

module.exports = { readCompanies };
