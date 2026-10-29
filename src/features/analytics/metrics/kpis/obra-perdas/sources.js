'use strict';

/**
 * M9-D652 — leitura dos read models de Obras para os KPIs de desperdício, custo pós-obra e recorrência: a entrada da fórmula, os parâmetros, o filtro canônico
 * (M9-D611: os registros da origem que reproduzem o número) e o instante da fonte. Só lê o schema analytics (nunca o OLTP). Posição: o read model guarda o
 * estado atual, por isso o cálculo vale para o dia de hoje (o provedor do snapshot diário cuida disso).
 */
const { sequelize } = require('../../../../../models');
const { readRecurrenceParams } = require('../../../read-models/obraPerdasKpi.settings');
const { NIL_PROJECT } = require('../../../read-models/obra.resolve');
const { latestSnapshotAt } = require('../snapshotAt');
const { MODELS } = require('./models');

const rows = async (sql, replacements, transaction) => (await sequelize.query(sql, { replacements, transaction }))[0];

async function wasteItem(scope, transaction) {
  const list = await rows(
    `SELECT project_id::text AS "projectId", material_id::text AS "materialId", waste_value::text AS "wasteValue", movements_without_cost AS "withoutCost", consumption_value::text AS "consumptionValue"
       FROM analytics.${MODELS.waste} WHERE company_id = :companyId ORDER BY project_id, material_id`, { companyId: scope.companyId }, transaction
  );
  return { inputs: { rows: list }, params: {}, filter: { equals: { movementType: 'LOSS' } }, snapshotAt: await latestSnapshotAt(scope.companyId, [MODELS.waste], transaction), readModel: MODELS.waste };
}

async function postworkItem(scope, transaction) {
  const list = await rows(
    `SELECT project_id::text AS "projectId", cause, team_id AS team, material_id AS material, cases_total AS cases, warranty_cost::text AS cost, warranty_cost_open::text AS "openCost"
       FROM analytics.${MODELS.postwork} WHERE company_id = :companyId ORDER BY project_id, cause, team_id, material_id`, { companyId: scope.companyId }, transaction
  );
  const revenue = Object.fromEntries((await rows(
    `SELECT project_id::text AS id, contract_revenue::text AS revenue FROM analytics.${MODELS.cost} WHERE company_id = :companyId AND project_id::text IN (:ids)`,
    { companyId: scope.companyId, ids: [...new Set(list.map((r) => r.projectId)), NIL_PROJECT] }, transaction
  )).map((r) => [r.id, r.revenue]));
  return {
    inputs: { noProject: NIL_PROJECT, rows: list, revenue }, params: {}, filter: { equals: { deletedAt: null } },
    snapshotAt: await latestSnapshotAt(scope.companyId, [MODELS.postwork, MODELS.cost], transaction), readModel: MODELS.postwork,
  };
}

async function recurrenceItem(scope, asOfDate, transaction) {
  const params = await readRecurrenceParams(scope, transaction);
  const list = await rows(
    `SELECT project_id::text AS "projectId", occurrence_id::text AS id, occurred_on::text AS "occurredOn", cause, teams, materials, cost::text AS cost
       FROM analytics.${MODELS.occurrences} WHERE company_id = :companyId AND occurred_on <= CAST(:asOf AS date) AND occurred_on >= CAST(:asOf AS date) - CAST(:days AS integer)
      ORDER BY project_id, occurrence_type, occurrence_id`, { companyId: scope.companyId, asOf: asOfDate, days: params.windowDays }, transaction
  );
  return {
    inputs: { asOfDate, notInformed: 'NAO_INFORMADA', rows: list }, params, filter: { equals: { deletedAt: null } },
    snapshotAt: await latestSnapshotAt(scope.companyId, [MODELS.occurrences], transaction), readModel: MODELS.occurrences,
  };
}

/** { código: { inputs, params, filter, snapshotAt, periodStart? } } dos três KPIs. */
async function buildObraCostItems(scope, asOfDate, transaction) {
  return {
    'obra.waste': await wasteItem(scope, transaction),
    'obra.postwork_cost': await postworkItem(scope, transaction),
    'obra.recurrence': await recurrenceItem(scope, asOfDate, transaction),
  };
}

module.exports = { buildObraCostItems };
