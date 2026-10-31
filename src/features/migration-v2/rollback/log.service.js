'use strict';

const errors = require('./rollback.errors');
const { FIELD_MAX } = require('./rollback.constants');
const typesRepo = require('./types.repository');
const logRepo = require('./log.repository');
const cutover = require('./cutover.service');
const { ensureTypes } = require('./rollback.seed');

const snake = (name) => String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
const cents = (amount) => {
  const value = Number(amount);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
};

/**
 * Registra uma operação externa feita no sistema novo (M9-D907 §3.2). Antes do GO (sem T0) não há o que registrar. Depois do GO, toda operação ligada a um tipo do inventário
 * (campo `operations`) é gravada em `governance.external_op_log` NA MESMA transação do envio; operação perigosa que nenhum tipo cobre cria o tipo sem plano (IRREVERSIBLE, a Torre
 * abre o blocker GOV_ROLLBACK_COMPENSATION_REQUIRED até o plano ser cadastrado). Se o registro falhar, a operação falha junto (503 GOV_ROLLBACK_LOG_FAILED) e nada sai.
 * `op`: operation, reference, dispatchId, amountCents, entity, dangerous.
 */
async function recordExternalOp(tenant, op, transaction) {
  try {
    if (!(await cutover.currentT0(tenant, transaction))) return null;
    await ensureTypes(tenant, transaction);
    let type = await typesRepo.findByOperation(tenant, op.operation, transaction);
    if (!type && op.dangerous) type = await typesRepo.createUnmapped(tenant, { code: `UNMAPPED_${snake(op.operation)}`.slice(0, FIELD_MAX.code), module: 'INTEGRATIONS', operation: op.operation }, transaction);
    if (!type) return null;
    return await logRepo.insert(tenant, {
      typeId: type.id, opType: type.code, reference: String(op.reference || op.dispatchId || op.operation).slice(0, FIELD_MAX.ref), entity: op.entity || type.entity || null,
      amountCents: op.amountCents === undefined ? null : op.amountCents, dispatchId: op.dispatchId || null,
    }, transaction);
  } catch (error) {
    throw errors.logFailed({ operation: op && op.operation, cause: error && error.message });
  }
}

/** Gancho de `createDispatch` (integrations/dispatch): registra o envio recém-criado. `d` é o pedido original (snapshot e criticidade). */
function recordFromDispatch(ctx, dispatch, d, transaction) {
  const snapshot = d && d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : {};
  return recordExternalOp({ groupId: ctx.groupId, companyId: ctx.companyId }, {
    operation: dispatch.operation, reference: dispatch.aggregateId || dispatch.id, dispatchId: dispatch.id, amountCents: cents(snapshot.amount), dangerous: (d.criticalityOp || 'DANGEROUS') === 'DANGEROUS',
  }, transaction);
}

module.exports = { recordExternalOp, recordFromDispatch };
