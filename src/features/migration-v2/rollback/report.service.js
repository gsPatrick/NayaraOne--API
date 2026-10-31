'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { getSetting } = require('../../settings/settings.service');
const cutover = require('./cutover.service');
const settings = require('./rollback.settings');
const { ensureTypes } = require('./rollback.seed');
const { NEEDS_COMPENSATION, STATES, NEVER_SENT } = require('./rollback.constants');

const select = (sql, replacements, transaction) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Operações desde T0 que precisam de compensação, com o estado de cada uma: o do item de rollback, ou PENDING_COMPENSATION enquanto não há item. */
const BASE = `
  FROM governance.external_op_log l
  JOIN governance.external_op_types t ON t.company_id = l.company_id AND t.id = l.type_id
  LEFT JOIN governance.rollback_items i ON i.company_id = l.company_id AND i.log_id = l.id
  LEFT JOIN integration.dispatches d ON d.id = l.dispatch_id AND d.company_id = l.company_id
  WHERE l.company_id = :companyId AND l.executed_at >= :t0 AND t.reversibility IN (:needs) AND (d.id IS NULL OR d.status NOT IN (:never))`;

async function pageSize(tenant, transaction) {
  return getSetting(settings.PAGE_SIZE_KEY, tenant, transaction, settings.ROLLBACK_SETTING_DEFAULTS[settings.PAGE_SIZE_KEY]);
}

/**
 * GET /migration/rollback-report (M9-D907 §3.3): desde T0, as operações IRREVERSIBLE e COMPENSABLE agrupadas por tipo, com o procedimento, o responsável, a soma em centavos
 * e o estado (PENDING_COMPENSATION, COMPENSATED). `complete` só é verdadeiro sem nenhuma pendência. Com `?type=<código>` devolve também as operações do tipo, paginadas
 * (`?page=`; tamanho da página no parâmetro migracao.rollback.itens_por_pagina).
 */
async function getReport(tenant, query, transaction) {
  await ensureTypes(tenant, transaction);
  const t0 = await cutover.currentT0(tenant, transaction);
  const empty = { t0: null, hasGo: false, complete: false, totals: { operations: 0, pending: 0, compensated: 0, amountCents: 0 }, groups: [] };
  if (!t0) return empty;
  const base = { companyId: tenant.companyId, t0, needs: NEEDS_COMPENSATION, never: NEVER_SENT };
  const rows = await select(
    `SELECT t.code AS "opType", t.module, t.reversibility, t.compensation, t.procedure, t.owner, t.entity, count(*)::int AS count, COALESCE(sum(l.amount_cents), 0)::bigint AS "amountCents",
            count(*) FILTER (WHERE COALESCE(i.state, :pending) = :pending)::int AS pending, count(*) FILTER (WHERE i.state = :compensated)::int AS compensated
     ${BASE} GROUP BY t.code, t.module, t.reversibility, t.compensation, t.procedure, t.owner, t.entity ORDER BY t.code`,
    { ...base, pending: STATES.PENDING, compensated: STATES.COMPENSATED }, transaction
  );
  const groups = rows.map((r) => ({ ...r, amountCents: Number(r.amountCents) }));
  const totals = groups.reduce((acc, g) => ({ operations: acc.operations + g.count, pending: acc.pending + g.pending, compensated: acc.compensated + g.compensated, amountCents: acc.amountCents + g.amountCents }), empty.totals);
  const out = { t0, hasGo: true, complete: totals.pending === 0, totals, groups };
  if (query && query.type) {
    const size = await pageSize(tenant, transaction);
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    out.items = {
      type: String(query.type).toUpperCase(), page, pageSize: size,
      rows: await select(
        `SELECT l.id AS "logId", l.reference, l.executed_at AS "executedAt", l.entity, l.amount_cents AS "amountCents", i.id AS "itemId", i.sector, COALESCE(i.state, :pending) AS state
         ${BASE} AND t.code = :type ORDER BY l.executed_at, l.id LIMIT :size OFFSET :offset`,
        { ...base, pending: STATES.PENDING, type: String(query.type).toUpperCase(), size, offset: (page - 1) * size }, transaction
      ),
    };
  }
  return out;
}

module.exports = { getReport };
