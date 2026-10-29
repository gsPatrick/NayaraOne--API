'use strict';

const { registrarAuditoria } = require('../../../../engines/audit/auditLog.service');
const E = require('../bcp.errors');
const normalize = require('../import/normalize');
const { registerGuard } = require('../import/guards');
const repository = require('./checks.repository');
const { ACTION, ROLE, APPROVE, EVENT_CHECKED } = require('./payment.constants');

async function audit({ tenant, actorUserId, operation, role, userId, at }, transaction) {
  await registrarAuditoria({
    groupId: tenant.groupId, companyId: tenant.companyId, actorUserId, action: EVENT_CHECKED, entityType: 'ManualOperation', entityId: operation.id,
    beforeJson: null, afterJson: { role, userId, at, manualReference: operation.manualReference },
    reason: `Conferência ${role === ROLE.CHECKER_1 ? '1 (preparo)' : '2 (importação)'} do pagamento manual ${operation.manualReference}.`,
  }, transaction);
}

/** checker_1 = quem registrou a operação; vale desde o registro (`recorded_at`). Idempotente: o registro e a guarda gravam o mesmo papel sem repetir. */
async function recordPreparer({ tenant, operation }, transaction) {
  const row = await repository.insertCheck({
    groupId: tenant.groupId, companyId: tenant.companyId, manualOperationId: operation.id, role: ROLE.CHECKER_1, userId: operation.actorUserId, at: operation.recordedAt,
  }, transaction);
  if (row) await audit({ tenant, actorUserId: operation.actorUserId, operation, role: ROLE.CHECKER_1, userId: operation.actorUserId, at: row.at }, transaction);
  return row;
}

/** Os dois nomes manuscritos do papel (conferente 1 e 2): preenchidos e diferentes, sem diferenciar maiúsculas, acentos e espaços repetidos. */
function assertPaperNames(payload) {
  const one = normalize.text(payload && payload.conferente1);
  const two = normalize.text(payload && payload.conferente2);
  if (!one || !two || one === two) throw E.paymentDoubleCheck();
}

/**
 * Guarda da importação do pagamento emergencial (M9-D833 §3.2): o usuário que importa (checker_2) tem `governance:bcp:approve`, é outra pessoa que quem registrou (checker_1) e o
 * papel traz dois conferentes diferentes. Só então grava as duas conferências, dentro da transação do item (se o comando falha, tudo volta).
 */
async function paymentGuard({ tenant, actorUserId, operation, transaction }) {
  if (operation.intendedAction !== ACTION) return;
  await assertApprover(tenant, actorUserId, transaction);
  if (operation.actorUserId === actorUserId) throw E.paymentSamePerson();
  assertPaperNames(operation.payload);
  await recordPreparer({ tenant, operation }, transaction);
  const row = await repository.insertCheck({ groupId: tenant.groupId, companyId: tenant.companyId, manualOperationId: operation.id, role: ROLE.CHECKER_2, userId: actorUserId }, transaction);
  if (row) await audit({ tenant, actorUserId, operation, role: ROLE.CHECKER_2, userId: actorUserId, at: row.at }, transaction);
}

/** 403 PERMISSION_DENIED quando o usuário não tem a permissão de conferir. */
async function assertApprover(tenant, userId, transaction) {
  if (!(await repository.userHasPermission(tenant.companyId, userId, APPROVE, transaction))) throw E.permissionMissing(APPROVE);
}

registerGuard(paymentGuard);

module.exports = { paymentGuard, recordPreparer, assertApprover, assertPaperNames };
