'use strict';

/**
 * M9-D615 — read model rm_finance_sector_margin (schema analytics): receita e custo realizados por setor (centro de resultado) e mês de competência,
 * para a margem por setor. Por EMPRESA. Lançamento sem centro de resultado vai para o setor "sem setor" (UUID zero na chave). Os eventos de
 * lançamento carregam resultCenterId e competenceMonth (DI-D615-2); a agenda reconfere o mês atual e o anterior.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { ENTRY_EVENTS } = require('./financeHealth.events');
const { readSectorMargin } = require('./financeHealth.entries');
const { businessDateKey } = require('../../../utils/businessDate');

const NO_CENTER = '00000000-0000-0000-0000-000000000000';
const MODEL = 'rm_finance_sector_margin';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function aggregateKey(event) {
  const p = event.payloadJson || event.payload || {};
  if (!MONTH_RE.test(String(p.competenceMonth || ''))) return null;
  return { result_center_id: p.resultCenterId || NO_CENTER, competence_month: p.competenceMonth };
}

async function recompute({ companyId, key, transaction }) {
  const r = await readSectorMargin(companyId, { resultCenterId: key.result_center_id, competenceMonth: key.competence_month }, NO_CENTER, transaction);
  return { fields: { revenue_actual: r.revenue, cost_actual: r.cost } };
}

/** Setores e meses que têm lançamento liquidado no mês atual e no anterior (a agenda os reconfere). */
async function scheduledKeys({ companyId, now, limit, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT COALESCE(result_center_id, CAST(:nil AS uuid))::text AS result_center_id, competence_month
       FROM finance.financial_entries
      WHERE company_id = :companyId AND status = 'SETTLED' AND competence_month IN (:months) ORDER BY 2, 1 LIMIT :limit`,
    { replacements: { companyId, nil: NO_CENTER, months: recentMonths(now), limit: limit || 5000 }, transaction }
  );
  return rows;
}

function recentMonths(now) {
  const [y, m] = businessDateKey(now).split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return [`${y}-${String(m).padStart(2, '0')}`, prev];
}

/** M9-D699 / M9-D608: todos os setores e meses com lançamento liquidado na fonte, mais as linhas já gravadas (setor que zerou continua com a linha zerada). */
async function rebuildKeys({ companyId, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT COALESCE(result_center_id, CAST(:nil AS uuid))::text AS result_center_id, competence_month FROM finance.financial_entries
      WHERE company_id = :companyId AND status = 'SETTLED' AND competence_month IS NOT NULL
      UNION SELECT result_center_id::text, competence_month FROM analytics.${MODEL} WHERE company_id = :companyId ORDER BY 2, 1`,
    { replacements: { companyId, nil: NO_CENTER }, transaction }
  );
  return rows.filter((r) => MONTH_RE.test(r.competence_month));
}

const def = registerReadModel({
  name: MODEL, version: 1, keyColumns: ['result_center_id', 'competence_month'], eventTypes: [...ENTRY_EVENTS], aggregateKey, recompute, scheduled: { keys: scheduledKeys },
  rebuild: { keys: rebuildKeys, corrections: (args) => require('../metrics/kpis').financeKpiCorrections(args) }, // M9-D623: a margem por setor também revisa os snapshots do KPI
});

module.exports = { def, NO_CENTER, aggregateKey };
