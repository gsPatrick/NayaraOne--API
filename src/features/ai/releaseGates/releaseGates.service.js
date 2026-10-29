'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const repo = require('../readmodels/releaseGateSupport.readmodel');
const E = require('./releaseGates.errors');
const { parseRegister } = require('./releaseGates.validation');
const { toGate, auditSnapshot } = require('./releaseGates.mapper');
const { computeMissing, peopleOfItems } = require('./releaseGates.requirements');
const { STATUS, FINAL_ITEM } = require('./releaseGates.constants');
const { getSetting } = require('../../settings/settings.service');
const { PROVIDER_KEYS, PROVIDER_SETTING_DEFAULTS } = require('../providers/providers.settings');

async function audit(ctx, before, after, transaction) {
  await registrarAuditoria({
    groupId: ctx.groupId, companyId: ctx.companyId, actorUserId: ctx.userId || null, action: before ? 'ai.release_gate.updated' : 'ai.release_gate.created',
    entityType: 'AiReleaseGate', entityId: after.id, beforeJson: before ? auditSnapshot(before) : { registro: 'inexistente' }, afterJson: auditSnapshot(after),
    reason: `Portão de liberação da NAY: ${after.item} ${after.status}.`,
  }, transaction);
}

/**
 * A aprovação final só vale vinda de pessoa diferente de quem registrou ou aprovou os demais itens (403 AI_GATE_SELF_APPROVAL_BLOCKED) e com
 * o resto do portão completo (409 AI_PRODUCTION_GATE_INCOMPLETE).
 */
async function assertFinalApproval(ctx, transaction) {
  const { missing, rows } = await computeMissing(ctx, transaction, { includeFinal: false });
  if (peopleOfItems(rows).has(ctx.userId)) throw E.selfApproval();
  if (missing.length) throw E.incomplete(missing);
}

/** POST /v1/ai/release-gates: registra (ou atualiza) um item. Repetir a mesma Idempotency-Key devolve a mesma linha sem alterar nada. */
async function register(ctx, body, transaction) {
  if (!ctx.userId) throw E.invalid('O registro precisa de uma pessoa identificada.');
  const d = parseRegister(body);
  if (d.idempotencyKey) {
    const same = await repo.findByIdempotency(ctx.groupId, d.idempotencyKey, transaction);
    if (same) return { gate: toGate(same), replayed: true };
  }
  const companyId = d.level === 'GROUP' ? null : ctx.companyId;
  if (d.status === STATUS.APPROVED && d.item === FINAL_ITEM) await assertFinalApproval(ctx, transaction);
  const approved = d.status === STATUS.APPROVED;
  const values = {
    status: d.status, evidenceRef: d.evidenceRef, notes: d.notes, approvedBy: approved ? ctx.userId : null, approvedAt: approved ? new Date() : null,
    registeredBy: ctx.userId, idempotencyKey: d.idempotencyKey,
  };
  let before = await repo.findByKey({ companyId, item: d.item, scopeRef: d.scopeRef }, transaction, { lock: true });
  let row = before ? null : await repo.insert({ groupId: ctx.groupId, companyId, scopeType: d.scopeType, scopeRef: d.scopeRef, item: d.item, ...values }, transaction);
  if (!row) {
    // Outra conexão criou a mesma chave no mesmo instante: relê travando e atualiza (a última palavra é sempre auditada).
    before = before || await repo.findByKey({ companyId, item: d.item, scopeRef: d.scopeRef }, transaction, { lock: true });
    row = await repo.update(before.id, values, transaction);
  }
  await audit(ctx, before, row, transaction);
  return { gate: toGate(row), replayed: false };
}

/** GET /v1/ai/release-gates: as aprovações visíveis à empresa, o ambiente e o que ainda falta para PRODUCAO. */
async function list(ctx, query, transaction) {
  const rows = await repo.list({ item: query.item, status: query.status }, transaction);
  const { missing } = await computeMissing(ctx, transaction);
  const environment = await getSetting(PROVIDER_KEYS.environment, ctx, transaction, PROVIDER_SETTING_DEFAULTS[PROVIDER_KEYS.environment]);
  return { gates: rows.map(toGate), environment, complete: missing.length === 0, missing };
}

module.exports = { register, list, assertFinalApproval };
