'use strict';

/**
 * M9-D401 — criação idempotente de execução de automação.
 *
 * A chave (company_id, idempotency_key) é UNIQUE no banco; duas conexões disputando a mesma chave resultam em uma
 * linha só. Quem perde a corrida (ou repete o gatilho) recebe a execução existente com `replay: true` e o código
 * MKT_RUN_REPLAY, que o chamador devolve como HTTP 200 (não é erro).
 */

const { QueryTypes } = require('sequelize');
const { sequelize, MarketingAutomationRun } = require('../../models');

const REPLAY = { code: 'MKT_RUN_REPLAY', message: 'Esta execução já foi processada.' };

async function createRunIdempotent(data, { transaction } = {}) {
  const rows = await sequelize.query(
    `INSERT INTO marketing.automation_runs (group_id, company_id, automation_version_id, trigger_event_id, subject_type, subject_id,
        correlation_id, idempotency_key, status)
     VALUES (:groupId, :companyId, :automationVersionId, :triggerEventId, :subjectType, :subjectId, :correlationId, :idempotencyKey, 'STARTED')
     ON CONFLICT (company_id, idempotency_key) DO NOTHING
     RETURNING id`,
    {
      replacements: {
        groupId: data.groupId,
        companyId: data.companyId,
        automationVersionId: data.automationVersionId,
        triggerEventId: data.triggerEventId || null,
        subjectType: data.subjectType || null,
        subjectId: data.subjectId || null,
        correlationId: data.correlationId,
        idempotencyKey: data.idempotencyKey,
      },
      type: QueryTypes.SELECT,
      transaction,
    }
  );
  const run = await MarketingAutomationRun.findOne({
    where: { companyId: data.companyId, idempotencyKey: data.idempotencyKey },
    transaction,
  });
  if (rows.length === 1) return { run, replay: false };
  return { run, replay: true, ...REPLAY };
}

module.exports = { createRunIdempotent, MKT_RUN_REPLAY: REPLAY };
