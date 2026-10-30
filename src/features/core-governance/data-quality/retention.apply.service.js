'use strict';

const logger = require('../../../utils/logger');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const runRepository = require('./retention.run.repository');
const { assertApplicable } = require('./retention.apply.state');
const { processBatch } = require('./retention.apply.batch');
const { RUN_STATUS } = require('./retention.constants');
const errors = require('./retention.errors');

const audit = (tenant, actor, runId, action, afterJson, reason, transaction) => registrarAuditoria(
  { groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor.userId || null, action, entityType: 'RetentionRun', entityId: runId, beforeJson: null, afterJson, reason }, transaction
);

/**
 * Aplica a simulação `runId` (M9-D911 §3.3.3). `runTx(fn)` abre uma transação NOVA do tenant a cada chamada: cada lote é uma transação (lote com erro é desfeito; os lotes
 * concluídos ficam). Só parte de uma simulação existente e válida (409 GOV_RETENTION_DRY_RUN_REQUIRED), uma vez (409 GOV_RETENTION_ALREADY_APPLIED) e sob trava da rodada
 * (409 GOV_RETENTION_RUN_IN_PROGRESS). Falhou no meio: a rodada vira FAILED, 500 GOV_RETENTION_APPLY_FAILED, e chamar de novo retoma só os lotes pendentes.
 */
async function applyRun(tenant, actor, runId, { runTx, now = new Date() }) {
  const started = await runTx(async (transaction) => {
    const run = await runRepository.getRun(tenant, runId, transaction, { forUpdate: true });
    const mode = await assertApplicable(tenant, run, transaction, now);
    await runRepository.setStatus(runId, RUN_STATUS.APPLYING, { appliedBy: actor.userId }, transaction);
    await audit(tenant, actor, runId, 'governance.retention.apply.started', { resumed: mode === 'RESUME' }, mode === 'RESUME' ? 'Aplicação da retenção retomada.' : 'Aplicação da retenção iniciada.', transaction);
    return mode;
  });
  const ctx = { tenant, actor, now };
  try {
    for (;;) {
      const progressed = await runTx(async (transaction) => {
        const batch = await runRepository.nextBatch(runId, transaction);
        return batch ? processBatch(ctx, runId, batch, transaction) : null;
      });
      if (!progressed) break;
    }
  } catch (err) {
    logger.error({ runId, companyId: tenant.companyId, err: err.message }, '[Retention] Falha no lote do apply; rodada marcada como FAILED.');
    await runTx((transaction) => runRepository.setStatus(runId, RUN_STATUS.FAILED, { error: String(err.message).slice(0, 500) }, transaction)).catch(() => {});
    throw errors.applyFailed({ runId });
  }
  return runTx(async (transaction) => {
    const byTarget = await runRepository.stateCounts(runId, transaction);
    await runRepository.setStatus(runId, RUN_STATUS.APPLIED, { summary: { byTarget, resumed: started === 'RESUME' } }, transaction);
    await audit(tenant, actor, runId, 'governance.retention.apply.finished', { byTarget }, 'Aplicação da retenção concluída.', transaction);
    return runRepository.getRun(tenant, runId, transaction);
  });
}

module.exports = { applyRun };
