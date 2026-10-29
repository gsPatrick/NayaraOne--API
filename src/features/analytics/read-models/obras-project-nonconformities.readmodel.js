'use strict';

/**
 * M9-D618 — read model rm_project_nonconformities (schema analytics): por obra, causa e equipe, as não conformidades abertas, as fechadas nos
 * últimos 30 dias (data-base inclusive, calendário de São Paulo) e a soma dos dias que levaram para fechar (para a média da D651). Causa e equipe
 * são dimensões obrigatórias: registro sem causa (ou sem equipe) entra como 'NAO_INFORMADA' e baixa o score de qualidade (M9-D652). O agregado é a
 * obra: o recálculo troca todas as linhas dela. Só contagens e rótulos de causa e equipe; a descrição e o responsável não entram. A janela de 30 dias
 * se move com o relógio, por isso a agenda também recalcula.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { NONCONFORMITY_EVENTS } = require('./obra.events');
const { projectAggregateKey } = require('./obra.resolve');
const { BUSINESS_TIMEZONE } = require('../../../utils/businessDate');

const NOT_INFORMED = 'NAO_INFORMADA';
const CLOSED_IN_WINDOW = "n.status = 'CLOSED' AND n.closed_at IS NOT NULL AND (n.closed_at AT TIME ZONE :tz)::date BETWEEN CAST(:asOf AS date) - 29 AND CAST(:asOf AS date)";

async function recompute({ companyId, key, asOfDate, transaction }) {
  const [rows] = await sequelize.query(
    `SELECT COALESCE(NULLIF(upper(trim(n.cause_code)), ''), '${NOT_INFORMED}') AS cause, COALESCE(NULLIF(trim(n.team_label), ''), '${NOT_INFORMED}') AS team_id,
            (count(*) FILTER (WHERE n.status <> 'CLOSED'))::int AS open,
            (count(*) FILTER (WHERE ${CLOSED_IN_WINDOW}))::int AS closed_30d,
            COALESCE(SUM(GREATEST(0, (n.closed_at AT TIME ZONE :tz)::date - (n.created_at AT TIME ZONE :tz)::date)) FILTER (WHERE ${CLOSED_IN_WINDOW}), 0)::int AS close_days_sum
       FROM construction.nonconformities n WHERE n.company_id = :companyId AND n.project_id = :projectId AND n.deleted_at IS NULL
      GROUP BY 1, 2 HAVING count(*) FILTER (WHERE n.status <> 'CLOSED') > 0 OR count(*) FILTER (WHERE ${CLOSED_IN_WINDOW}) > 0 ORDER BY 1, 2`,
    { replacements: { companyId, projectId: key.project_id, asOf: asOfDate, tz: BUSINESS_TIMEZONE }, transaction }
  );
  return { rows: rows.map(({ cause, team_id: team, ...fields }) => ({ key: { cause, team_id: team }, fields })) };
}

/** Obras com não conformidade aberta ou fechada na janela (a janela anda com o dia). */
async function scheduledKeys({ companyId, now, limit, transaction }) {
  const since = new Date(now.getTime() - 45 * 86400000).toISOString();
  const [rows] = await sequelize.query(
    `SELECT DISTINCT project_id::text AS project_id FROM construction.nonconformities
      WHERE company_id = :companyId AND deleted_at IS NULL AND (status <> 'CLOSED' OR closed_at >= CAST(:since AS timestamptz)) ORDER BY 1 LIMIT :limit`,
    { replacements: { companyId, since, limit: limit || 5000 }, transaction }
  );
  return rows;
}

async function rebuildKeys({ companyId, transaction }) {
  const [rows] = await sequelize.query(
    'SELECT DISTINCT project_id::text AS project_id FROM construction.nonconformities WHERE company_id = :companyId AND deleted_at IS NULL ORDER BY 1',
    { replacements: { companyId }, transaction }
  );
  return rows;
}

const def = registerReadModel({
  name: 'rm_project_nonconformities',
  version: 1,
  keyColumns: ['project_id', 'cause', 'team_id'],
  aggregateColumns: ['project_id'],
  eventTypes: [...NONCONFORMITY_EVENTS],
  aggregateKey: projectAggregateKey,
  recompute,
  scheduled: { keys: scheduledKeys },
  rebuild: { keys: rebuildKeys },
});

module.exports = { def, recompute, NOT_INFORMED };
