'use strict';

/**
 * M9-D618 — read model rm_postwork_cost (schema analytics): por obra, causa, equipe e material, os casos de garantia (pós-obra) abertos e totais e
 * o custo da garantia. Custo = mão de obra e material do caso + custo de cada ação de garantia (mesma soma de postObraHealth). Causa = causa-raiz do
 * caso; equipe e material vêm da ação ('NAO_INFORMADA' quando não informados, M9-D652). Um caso aparece em cada combinação das suas ações; o custo
 * do próprio caso (sem equipe nem material) fica na combinação 'NAO_INFORMADA' sem contar o caso duas vezes. Caso sem obra vinculada vai para a obra
 * zero (o KPI marca DEGRADED). Só ids e rótulos; a descrição e o solicitante não entram. O agregado é a obra.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { WARRANTY_EVENTS } = require('./obra.events');
const { NIL_PROJECT, projectAggregateKey } = require('./obra.resolve');

const NI = 'NAO_INFORMADA';

async function recompute({ companyId, key, transaction }) {
  const [rows] = await sequelize.query(
    `WITH c AS (
       SELECT mc.id, mc.status, COALESCE(NULLIF(upper(trim(mc.root_cause_code)), ''), '${NI}') AS cause, COALESCE(mc.labor_cost, 0) + COALESCE(mc.material_cost, 0) AS own_cost,
              EXISTS (SELECT 1 FROM construction.warranty_actions a WHERE a.warranty_case_id = mc.id AND a.company_id = :companyId AND a.deleted_at IS NULL) AS has_actions
         FROM construction.maintenance_cases mc
        WHERE mc.company_id = :companyId AND mc.deleted_at IS NULL AND COALESCE(mc.project_id, CAST(:nil AS uuid)) = :projectId),
     u AS (
       SELECT c.id, c.status, c.cause, '${NI}' AS team, '${NI}' AS material, c.own_cost AS cost, NOT c.has_actions AS counts_case FROM c
       UNION ALL
       SELECT c.id, c.status, c.cause, COALESCE(NULLIF(trim(a.assigned_team), ''), '${NI}'), COALESCE(NULLIF(trim(a.material_used), ''), '${NI}'), COALESCE(a.cost, 0), true
         FROM c JOIN construction.warranty_actions a ON a.warranty_case_id = c.id AND a.company_id = :companyId AND a.deleted_at IS NULL)
     SELECT cause, team AS team_id, material AS material_id,
            (count(DISTINCT id) FILTER (WHERE counts_case AND status <> 'CLOSED'))::int AS cases_open,
            (count(DISTINCT id) FILTER (WHERE counts_case))::int AS cases_total,
            COALESCE(SUM(cost), 0)::text AS warranty_cost
       FROM u GROUP BY 1, 2, 3 HAVING count(DISTINCT id) FILTER (WHERE counts_case) > 0 OR COALESCE(SUM(cost), 0) <> 0 ORDER BY 1, 2, 3`,
    { replacements: { companyId, projectId: key.project_id, nil: NIL_PROJECT }, transaction }
  );
  return { rows: rows.map(({ cause, team_id: team, material_id: material, ...fields }) => ({ key: { cause, team_id: team, material_id: material }, fields })) };
}

async function casesProjectKeys({ companyId, limit, onlyOpen, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT COALESCE(project_id, CAST(:nil AS uuid))::text AS project_id FROM construction.maintenance_cases
      WHERE company_id = :companyId AND deleted_at IS NULL ${onlyOpen ? "AND status <> 'CLOSED'" : ''} ORDER BY 1 LIMIT :limit`,
    { replacements: { companyId, nil: NIL_PROJECT, limit: limit || 100000 }, transaction }
  );
  return rows;
}

const def = registerReadModel({
  name: 'rm_postwork_cost',
  version: 1,
  keyColumns: ['project_id', 'cause', 'team_id', 'material_id'],
  aggregateColumns: ['project_id'],
  eventTypes: [...WARRANTY_EVENTS],
  aggregateKey: projectAggregateKey,
  recompute,
  // Ações de garantia (custo, equipe, material) não publicam evento: a agenda reconfere os casos abertos.
  scheduled: { keys: (ctx) => casesProjectKeys({ ...ctx, onlyOpen: true }) },
  rebuild: { keys: (ctx) => casesProjectKeys({ ...ctx, onlyOpen: false }) },
});

module.exports = { def, recompute };
