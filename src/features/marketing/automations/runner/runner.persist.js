'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');

const run = (sql, replacements, transaction) => sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });

const RUN_COLUMNS = `id, automation_version_id, trigger_event_id, subject_type, subject_id, correlation_id, idempotency_key, status, blocked_reason, policy_trace, next_due_at,
  actions_result, started_at, finished_at`;

/** Grava o que o runner decidiu (passos 1 a 6): bloqueio, rastro e a lista de ações planejada. */
async function writePlan(runId, { blockedReason, trace, actionsResult }, transaction) {
  await run(
    `UPDATE marketing.automation_runs SET blocked_reason = :blockedReason, policy_trace = CAST(:trace AS jsonb), actions_result = CAST(:actions AS jsonb), updated_at = now()
      WHERE id = :runId RETURNING id`,
    { runId, blockedReason: blockedReason || null, trace: JSON.stringify(trace), actions: JSON.stringify(actionsResult) }, transaction
  );
}

/** Estado final ou de espera da run (passos 7 a 9). `finished`: marca finished_at; WAITING exige next_due_at (constraint do banco). */
async function writeOutcome(runId, { status, blockedReason, trace, actionsResult, nextDueAt }, transaction) {
  await run(
    `UPDATE marketing.automation_runs SET status = :status, blocked_reason = :blockedReason, policy_trace = CAST(:trace AS jsonb), actions_result = CAST(:actions AS jsonb),
        next_due_at = :nextDueAt, finished_at = CASE WHEN :status IN ('COMPLETED','BLOCKED','FAILED') THEN now() ELSE NULL END, updated_at = now()
      WHERE id = :runId RETURNING id`,
    { runId, status, blockedReason: blockedReason || null, trace: JSON.stringify(trace), actions: JSON.stringify(actionsResult), nextDueAt: nextDueAt || null }, transaction
  );
}

const lockRun = async (runId, transaction) => (await run(`SELECT ${RUN_COLUMNS} FROM marketing.automation_runs WHERE id = :runId FOR UPDATE`, { runId }, transaction))[0] || null;

/** Runs WAITING com ação vencida, travadas com SKIP LOCKED: dois executores simultâneos nunca pegam a mesma. */
const lockDueRuns = (now, transaction) => run(
  `SELECT ${RUN_COLUMNS} FROM marketing.automation_runs WHERE status = 'WAITING' AND next_due_at <= :now ORDER BY next_due_at, id FOR UPDATE SKIP LOCKED`, { now }, transaction
);

/** Runs STARTED sem fim há mais de `timeoutS` (a regra de run travada da M9-D415; WAITING nunca entra). */
const lockStuckRuns = (now, timeoutS, transaction) => run(
  `SELECT ${RUN_COLUMNS} FROM marketing.automation_runs WHERE status = 'STARTED' AND finished_at IS NULL AND started_at < :limit ORDER BY started_at, id FOR UPDATE SKIP LOCKED`,
  { limit: new Date(now.getTime() - timeoutS * 1000) }, transaction
);

const runsOfEvent = (companyId, eventId, transaction) => run('SELECT id, status, blocked_reason, automation_version_id FROM marketing.automation_runs WHERE company_id = :companyId AND trigger_event_id = :eventId ORDER BY created_at, id', { companyId, eventId }, transaction);

module.exports = { writePlan, writeOutcome, lockRun, lockDueRuns, lockStuckRuns, runsOfEvent };
