'use strict';

const { sequelize } = require('../../../../models');

/** Abre a tentativa ANTES da chamada (started_at) e devolve o id; é o que o limitador local e a saúde enxergam. */
async function startAttempt(ctx, dispatch, now, transaction) {
  const [rows] = await sequelize.query(
    `INSERT INTO "integration"."dispatch_attempts" (group_id, company_id, dispatch_id, connection_id, provider_code, attempt_no, started_at)
     VALUES (:groupId, :companyId, :dispatchId, :connectionId, :providerCode, :attemptNo, :startedAt) RETURNING id`,
    { replacements: { groupId: ctx.groupId, companyId: ctx.companyId, dispatchId: dispatch.id, connectionId: dispatch.connectionId, providerCode: dispatch.providerCode, attemptNo: dispatch.attempts, startedAt: now }, transaction },
  );
  return rows[0].id;
}

/** Fecha a tentativa com o resultado: só classe, código, status HTTP e latência, nunca conteúdo. */
async function finishAttempt(attemptId, result, transaction) {
  await sequelize.query(
    `UPDATE "integration"."dispatch_attempts" SET finished_at = :finishedAt, outcome = :outcome, error_class = :errorClass, error_code = :errorCode,
       http_status = :httpStatus, latency_ms = :latencyMs WHERE id = :id`,
    {
      replacements: {
        id: attemptId, finishedAt: result.finishedAt || new Date(), outcome: result.outcome, errorClass: result.errorClass || null,
        errorCode: result.errorCode ? String(result.errorCode).slice(0, 64) : null, httpStatus: Number.isInteger(result.httpStatus) ? result.httpStatus : null,
        latencyMs: Number.isFinite(result.latencyMs) ? Math.max(0, Math.round(result.latencyMs)) : null,
      },
      transaction,
    },
  );
}

module.exports = { startAttempt, finishAttempt };
