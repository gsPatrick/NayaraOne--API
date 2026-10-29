'use strict';

/**
 * M9-D619 — read model rm_legal_cases_risk (schema analytics): a contagem de processos ATIVOS por nível de risco e tipo de processo. Ativo = status e
 * fase fora da lista do parâmetro analytics.juridico.processo_encerrado_status (padrão CLOSED, ARCHIVED, CANCELLED). Processo sem nível de risco entra em
 * 'SEM_CLASSIFICACAO' (o KPI avisa quando passa do limite, M9-D660). O agregado é a empresa inteira: o recálculo troca todas as linhas (um processo que
 * muda de risco mexe em duas linhas). Só contagens: partes, teor e advogado não entram.
 */
const { sequelize } = require('../../../models');
const { registerReadModel } = require('./readModel.registry');
const { CASE_EVENTS } = require('./juridico.events');
const { readFinishedStatuses } = require('./juridico.settings');
const { companyAggregateKey, companyKeys } = require('./companyAggregate.keys');

async function recompute({ companyId, groupId, transaction }) {
  const finished = await readFinishedStatuses({ companyId, groupId }, transaction);
  const [rows] = await sequelize.query(
    `SELECT COALESCE(NULLIF(upper(risk_level), ''), 'SEM_CLASSIFICACAO') AS risk_level, case_type, (count(*))::int AS count
       FROM legal.legal_cases
      WHERE company_id = :companyId AND deleted_at IS NULL AND upper(status) NOT IN (:finished) AND upper(COALESCE(phase, '')) NOT IN (:finished)
      GROUP BY 1, 2 ORDER BY 1, 2`,
    { replacements: { companyId, finished }, transaction }
  );
  return { rows: rows.map(({ risk_level: risk, case_type: type, count }) => ({ key: { risk_level: risk, case_type: type }, fields: { count } })) };
}

const def = registerReadModel({
  name: 'rm_legal_cases_risk',
  version: 1,
  keyColumns: ['risk_level', 'case_type'],
  aggregateColumns: [],
  eventTypes: [...CASE_EVENTS],
  aggregateKey: companyAggregateKey,
  recompute,
  rebuild: { keys: companyKeys },
});

module.exports = { def, recompute };
