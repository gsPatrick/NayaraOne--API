'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { getSetting } = require('../../../settings/settings.service');
const { govError } = require('../../governance.errors');
const { STATUS } = require('../bcp.constants');
const { LIST_LIMIT_KEY, BCP_SETTING_DEFAULTS } = require('../bcp.settings');
const { assertUserSector, userSectors } = require('../bcp.sectors');
const E = require('../bcp.errors');
const operations = require('../manualOperation.repository');
const repository = require('./import.repository');
const { adapterFor } = require('./adapters');
const { toBcpError } = require('./import.errors');

const DECISIONS = ['ACCEPT', 'REVERSE'];

/**
 * POST /bcp/reconciliations/:id/decide (M9-D832 §3.1 item 5): o responsável do setor decide a divergência. ACCEPT leva a operação a RECONCILED; REVERSE chama o estorno do
 * serviço normal (mesmo idempotencyKey com sufixo `:reverse`) e leva a REJECTED. A justificativa é obrigatória. Decidir duas vezes: 409 GOV_BCP_ALREADY_FINAL; estorno
 * recusado pelo serviço normal: 422 GOV_BCP_COMMAND_REJECTED e nada muda.
 */
async function decide({ tenant, actorUserId, id, body, transaction }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw govError(400, 'VALIDATION_ERROR', 'Envie o corpo da requisição em JSON.', { field: 'body' });
  if (!DECISIONS.includes(body.decision)) throw govError(400, 'VALIDATION_ERROR', `A decisão deve ser uma destas: ${DECISIONS.join(', ')}.`, { field: 'decision' });
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) throw E.decisionNoteRequired();
  const reconciliation = await repository.findReconciliation(tenant.companyId, id, transaction, { lock: true });
  if (!reconciliation) throw govError(404, 'GOV_NOT_FOUND', 'Reconciliação não encontrada.');
  const operation = await operations.findById(tenant.companyId, reconciliation.manualOperationId, transaction, { lock: true });
  await assertUserSector(actorUserId, tenant, operation.sector, transaction, 'decidir divergências');
  if (reconciliation.decision || reconciliation.result !== 'DIVERGENT' || operation.status !== STATUS.IMPORTED) throw E.alreadyFinal();

  let status = STATUS.RECONCILED;
  if (body.decision === 'REVERSE') {
    const imported = await repository.findImport(tenant.companyId, operation.manualReference, transaction);
    try {
      await adapterFor(operation.intendedAction).reverse({ tenant, actorUserId, operation, effect: imported.effect, transaction });
    } catch (err) {
      throw toBcpError(err);
    }
    status = STATUS.REJECTED;
  }
  const updated = await repository.applyDecision(tenant.companyId, reconciliation.id, { decision: body.decision, decidedBy: actorUserId, note, reconciledBy: status === STATUS.RECONCILED ? actorUserId : null }, transaction);
  await repository.setOperationState(tenant.companyId, operation.id, { status, rejectReason: status === STATUS.REJECTED ? note : null }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: 'bcp.reconciliation.decided', entityType: 'Reconciliation', entityId: reconciliation.id,
    beforeJson: { status: operation.status, diff: reconciliation.diff }, afterJson: { status, decision: body.decision, note, manualReference: operation.manualReference },
    reason: `Divergência da operação ${operation.manualReference} decidida: ${body.decision === 'ACCEPT' ? 'aceita' : 'estornada'}.`,
  }, transaction);
  return { ...updated, manualReference: operation.manualReference, sector: operation.sector, operationStatus: status };
}

/** GET /bcp/reconciliations: reconciliações dos setores do usuário; filtros `result`, `pending` (true = divergência sem decisão), `limit`, `offset`. */
async function list({ tenant, actorUserId, query = {}, transaction }) {
  const sectors = await userSectors(actorUserId, tenant, transaction);
  if (query.result && !['MATCHED', 'DIVERGENT'].includes(query.result)) throw govError(400, 'VALIDATION_ERROR', 'O resultado deve ser MATCHED ou DIVERGENT.', { field: 'result' });
  if (!sectors.length) return [];
  const max = Number(await getSetting(LIST_LIMIT_KEY, tenant, transaction, BCP_SETTING_DEFAULTS[LIST_LIMIT_KEY]));
  const asked = Number.parseInt(query.limit, 10);
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, max) : max;
  const pending = query.pending === undefined ? undefined : String(query.pending) === 'true';
  return repository.listReconciliations(tenant.companyId, { sectors, result: query.result, pending, limit, offset: Math.max(0, Number.parseInt(query.offset, 10) || 0) }, transaction);
}

module.exports = { decide, list };
