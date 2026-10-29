'use strict';

/**
 * M9-D652 — read model rm_project_occurrences (schema analytics): uma linha por ocorrência de obra, que é uma não conformidade ou um caso de garantia
 * (pós-obra) vinculado a uma obra, com a data de São Paulo, a causa, as equipes e os materiais e o custo. É a base do KPI obra.recurrence, cuja janela
 * (analytics.obra.recorrencia_dias) é parâmetro e se aplica na leitura. Causa, equipe e material sem informação entram como 'NAO_INFORMADA' (a equipe
 * ou o material informado só some do rótulo se houver outro; a lista nunca é vazia). Custo do caso = mão de obra + material + custo de cada ação de
 * garantia (mesma soma do rm_postwork_cost); a não conformidade não tem custo. Caso sem obra não entra (o pós-obra o acusa). O agregado é a obra.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { NONCONFORMITY_EVENTS, WARRANTY_EVENTS } = require('./obra.events');
const { projectAggregateKey, allProjectKeys } = require('./obra.resolve');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

const NI = 'NAO_INFORMADA';

/** Rótulos distintos e ordenados de uma coluna de texto das ações do caso; sem nenhum, ["NAO_INFORMADA"]. */
const labels = (column) => `COALESCE((SELECT jsonb_agg(DISTINCT v ORDER BY v) FROM (SELECT NULLIF(trim(a.${column}), '') AS v FROM construction.warranty_actions a
          WHERE a.warranty_case_id = mc.id AND a.company_id = :companyId AND a.deleted_at IS NULL) x WHERE v IS NOT NULL), '["${NI}"]'::jsonb)`;

async function recompute({ companyId, key, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT 'NONCONFORMITY' AS occurrence_type, n.id::text AS occurrence_id, (n.created_at AT TIME ZONE :tz)::date AS occurred_on,
            COALESCE(NULLIF(upper(trim(n.cause_code)), ''), '${NI}') AS cause,
            jsonb_build_array(COALESCE(NULLIF(trim(n.team_label), ''), '${NI}')) AS teams, '["${NI}"]'::jsonb AS materials, 0::numeric AS cost
       FROM construction.nonconformities n WHERE n.company_id = :companyId AND n.project_id = :projectId AND n.deleted_at IS NULL
     UNION ALL
     SELECT 'WARRANTY_CASE', mc.id::text, (mc.created_at AT TIME ZONE :tz)::date, COALESCE(NULLIF(upper(trim(mc.root_cause_code)), ''), '${NI}'),
            ${labels('assigned_team')}, ${labels('material_used')},
            COALESCE(mc.labor_cost, 0) + COALESCE(mc.material_cost, 0)
              + COALESCE((SELECT SUM(a.cost) FROM construction.warranty_actions a WHERE a.warranty_case_id = mc.id AND a.company_id = :companyId AND a.deleted_at IS NULL), 0)
       FROM construction.maintenance_cases mc WHERE mc.company_id = :companyId AND mc.project_id = :projectId AND mc.deleted_at IS NULL
     ORDER BY 1, 2`,
    { replacements: { companyId, projectId: key.project_id, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { rows: rows.map(({ occurrence_type: type, occurrence_id: id, ...fields }) => ({ key: { occurrence_type: type, occurrence_id: id }, fields })) };
}

/** Ações de garantia não publicam evento: a agenda reconfere as obras com caso aberto. */
async function scheduledKeys({ companyId, limit, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT DISTINCT project_id::text AS project_id FROM construction.maintenance_cases
      WHERE company_id = :companyId AND deleted_at IS NULL AND project_id IS NOT NULL AND status <> 'CLOSED' ORDER BY 1 LIMIT :limit`,
    { replacements: { companyId, limit: limit || 5000 }, transaction }
  );
  return rows;
}

const def = registerReadModel({
  name: 'rm_project_occurrences',
  version: 1,
  keyColumns: ['project_id', 'occurrence_type', 'occurrence_id'],
  aggregateColumns: ['project_id'],
  eventTypes: [...new Set([...NONCONFORMITY_EVENTS, ...WARRANTY_EVENTS])],
  aggregateKey: projectAggregateKey,
  recompute,
  scheduled: { keys: scheduledKeys },
  rebuild: { keys: allProjectKeys },
});

module.exports = { def, recompute };
