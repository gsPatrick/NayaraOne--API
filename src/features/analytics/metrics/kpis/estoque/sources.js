'use strict';

/**
 * M9-D653 — leitura dos read models de Estoque e Patrimônio para os KPIs: a entrada da fórmula, o filtro canônico (M9-D611: os registros da origem que
 * reproduzem o número, com a janela das perdas (a gravada na linha do read model, do parâmetro analytics.estoque.janela_perdas_dias) e o dia-base dos empréstimos em atraso) e o instante da fonte. Só lê o schema analytics (nunca o
 * OLTP). Cada read model tem uma linha por empresa e data-base; sem linha na data o KPI não gera snapshot (sai INCOMPLETE na leitura).
 */
const { sequelize } = require('../../../../../models');
const { readItemTypes } = require('../../../read-models/obra.settings');
const { saoPauloMidnight } = require('../../period');
const { MODELS } = require('./models');

const DEFAULT_LOSS_WINDOW_DAYS = 30; // linha antiga sem a janela gravada: o padrão do parâmetro (DI-D653-1)

function shiftDay(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

async function rowOf(model, scope, asOfDate, transaction) {
  const [rows] = await sequelize.query(`SELECT * FROM analytics.${model} WHERE company_id = :companyId AND as_of_date = :asOfDate`, { replacements: { companyId: scope.companyId, asOfDate }, transaction });
  return rows[0] || null;
}

const text = (v) => (v === null || v === undefined ? '0' : String(v));
const item = (row, model, inputs, filter, extra = {}) => ({ inputs, params: {}, filter, snapshotAt: row.source_snapshot_at, readModel: model, ...extra });

/** { código: item } dos KPIs cujo read model tem linha na data-base. */
async function buildInventoryItems(scope, asOfDate, transaction) {
  const out = {};
  const health = await rowOf(MODELS.health, scope, asOfDate, transaction);
  if (health) {
    const stockTypes = (await readItemTypes(scope, transaction)).join(',');
    const items = { equals: { stockTypes } };
    const windowStart = shiftDay(asOfDate, -((Number(health.losses_window_days) || DEFAULT_LOSS_WINDOW_DAYS) - 1)); // data-base e os dias anteriores da janela gravada
    out['inv.stock_value'] = item(health, MODELS.health, { value: text(health.stock_value), itemsWithoutCost: health.items_without_cost }, items);
    out['inv.below_minimum'] = item(health, MODELS.health, { belowMin: health.items_below_min, ruptures: health.ruptures, withoutMin: health.items_without_min }, items);
    out['inv.losses'] = item(
      health, MODELS.health, { value: text(health.losses_30d), count: health.losses_30d_count, open: health.losses_open, withoutValue: health.losses_without_value },
      { status: ['APPROVED'], period: { from: saoPauloMidnight(windowStart).toISOString(), to: saoPauloMidnight(asOfDate, 1).toISOString() } }
    ); // a janela vai no filtro; o período do snapshot fica no dia-base (a janela é parâmetro: trocá-la no dia revisa o mesmo snapshot, DI-D653-5)
  }
  const tools = await rowOf(MODELS.tools, scope, asOfDate, transaction);
  if (tools) {
    out['inv.tools_overdue'] = item(
      tools, MODELS.tools, { overdue: tools.loans_overdue, open: tools.loans_open, inMaintenance: tools.assets_in_maintenance, withoutDueDate: tools.loans_without_due_date },
      { status: ['OPEN', 'OVERDUE'], period: { from: null, to: asOfDate } }
    );
  }
  return out;
}

module.exports = { buildInventoryItems };
