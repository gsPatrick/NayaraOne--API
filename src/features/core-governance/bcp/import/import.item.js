'use strict';

const { sequelize } = require('../../../../models');
const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const { publishGovernanceEvent } = require('../../governance.events');
const { STATUS } = require('../bcp.constants');
const { validatePayload } = require('../bcp.payload');
const E = require('../bcp.errors');
const operations = require('../manualOperation.repository');
const templates = require('../formTemplates.repository');
const repository = require('./import.repository');
const { compareFields } = require('./compare');
const { adapterFor } = require('./adapters');
const { runGuards } = require('./guards');
require('../payment/payment.guard'); // registra a guarda da dupla checagem do pagamento emergencial (M9-D833)
const { toBcpError } = require('./import.errors');

const EVENT_IMPORTED = 'bcp.manual_operation.imported';

/** Resposta de um item do pedido (a mesma forma na primeira importação e nas repetidas; `alreadyImported` só diz qual das duas é). */
const view = (operation, reconciliation, commandRef, extra = {}) => ({
  id: operation.id, manualReference: operation.manualReference, sector: operation.sector, status: operation.status, commandRef: commandRef || null,
  reconciliation: reconciliation ? { id: reconciliation.id, result: reconciliation.result, diff: reconciliation.diff, decision: reconciliation.decision || null } : null,
  alreadyImported: false, error: null, ...extra,
});

const failure = (operation, error) => view(operation, null, null, { error: { code: error.code, message: error.message, details: error.details || null } });

/** Valida a operação RECORDED antes de executar: evidência ainda presente, payload contra o esquema do modelo (M9-D832 §3.1 item 2). */
async function validateOperation(tenant, operation, transaction) {
  if (!(await operations.evidenceExists(tenant.companyId, operation.evidenceFileId, transaction))) throw E.evidenceRequired();
  const template = await templates.findByFormType(operation.formType, transaction);
  const errors = validatePayload(template, operation.payload);
  if (errors.length) throw E.payloadInvalid(errors);
  return template;
}

/** O que acontece dentro da transação do item: guardas, comando normal, registro da importação, conferência, estado e evento. */
async function execute({ tenant, actorUserId, operation, transaction }) {
  await validateOperation(tenant, operation, transaction);
  await runGuards({ tenant, actorUserId, operation, transaction });
  const adapter = adapterFor(operation.intendedAction);
  const outcome = await adapter.execute({ tenant, actorUserId, operation, payload: operation.payload, transaction });
  const { result, diff } = compareFields(outcome.comparisons);
  const imported = await repository.insertImport({
    groupId: tenant.groupId, companyId: tenant.companyId, manualOperationId: operation.id, manualReference: operation.manualReference, intendedAction: operation.intendedAction,
    commandRef: outcome.commandRef, effect: { ...outcome.undo, compared: outcome.comparisons.map((item) => item.field) }, result, importedBy: actorUserId,
  }, transaction);
  if (!imported) throw E.alreadyFinal();
  const matched = result === 'MATCHED';
  // A conferência acontece ANTES do evento: MATCHED conclui a operação na hora; DIVERGENT espera a decisão do responsável do setor.
  const reconciliation = await repository.insertReconciliation({
    groupId: tenant.groupId, companyId: tenant.companyId, manualOperationId: operation.id, commandRef: outcome.commandRef, result, diff,
    reconciledBy: matched ? actorUserId : null, reconciledAt: matched ? new Date() : null,
  }, transaction);
  const status = matched ? STATUS.RECONCILED : STATUS.IMPORTED;
  await repository.setOperationState(tenant.companyId, operation.id, { status, importCommandRef: outcome.commandRef }, transaction);
  await publishGovernanceEvent({
    groupId: tenant.groupId, companyId: tenant.companyId, aggregateType: 'BcpManualOperation', aggregateId: operation.id, eventType: EVENT_IMPORTED,
    // A chave do outbox é única na plataforma toda; o número do papel só é único por empresa, então a empresa entra na chave (DI-D831-2).
    idempotencyKey: `${EVENT_IMPORTED}:${tenant.companyId}:${operation.manualReference}`,
    payload: { manualReference: operation.manualReference, sector: operation.sector, commandRef: outcome.commandRef, result },
  }, transaction);
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: EVENT_IMPORTED, entityType: 'ManualOperation', entityId: operation.id,
    beforeJson: { status: operation.status }, afterJson: { status, commandRef: outcome.commandRef, result, diff, reconciliationId: reconciliation.id },
    reason: `Operação manual ${operation.manualReference} importada (${result === 'MATCHED' ? 'conferência sem diferença' : 'divergência a decidir'}).`,
  }, transaction);
  return view({ ...operation, status }, reconciliation, outcome.commandRef);
}

/**
 * Importa UMA operação (M9-D832 §3.1). Tudo ou nada: o comando e a gravação saem num ponto de salvamento (SAVEPOINT) da transação do pedido; se algo falha, volta tudo
 * daquele item, a operação segue RECORDED com `last_error` e o item volta como falha, sem afetar os demais do lote. A operação é travada (FOR UPDATE): dois pedidos
 * simultâneos para a mesma referência executam o comando uma vez só e o segundo recebe a resposta do primeiro (`alreadyImported`).
 */
async function importOperation({ tenant, actorUserId, id, transaction }) {
  const operation = await operations.findById(tenant.companyId, id, transaction, { lock: true });
  if (!operation) return { id, manualReference: null, sector: null, status: null, commandRef: null, reconciliation: null, alreadyImported: false, error: { code: 'GOV_NOT_FOUND', message: 'Operação manual não encontrada.', details: null } };
  if (operation.status !== STATUS.RECORDED) {
    const prior = await repository.findImport(tenant.companyId, operation.manualReference, transaction);
    if (!prior) return failure(operation, E.alreadyFinal());
    const reconciliation = await repository.findReconciliationByOperation(tenant.companyId, operation.id, transaction);
    return view(operation, reconciliation, prior.commandRef, { alreadyImported: true });
  }
  try {
    return await sequelize.transaction({ transaction }, (savepoint) => execute({ tenant, actorUserId, operation, transaction: savepoint }));
  } catch (err) {
    const error = toBcpError(err);
    await repository.setLastError(tenant.companyId, operation.id, `${error.code}: ${error.message}`, transaction);
    return failure(operation, error);
  }
}

module.exports = { importOperation, EVENT_IMPORTED };
