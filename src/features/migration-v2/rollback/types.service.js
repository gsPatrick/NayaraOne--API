'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const errors = require('./rollback.errors');
const repo = require('./types.repository');
const { ensureTypes } = require('./rollback.seed');
const { normalizeBody } = require('./types.input');
const { AUDIT, AUDIT_ENTITY } = require('./rollback.constants');

const view = ({ id, ...rest }) => ({ id, ...rest });

/** GET /migration/external-ops: o inventário (semeia no primeiro acesso da empresa). */
async function listTypes(tenant, transaction) {
  await ensureTypes(tenant, transaction);
  return { types: (await repo.list(tenant, transaction)).map(view) };
}

/**
 * PUT /migration/external-ops (M9-D907 §3.1): grava os tipos informados, todos ou nenhum. Compensação sem texto, ou sem procedimento no tipo que não se desfaz sozinho: 422
 * GOV_ROLLBACK_COMPENSATION_REQUIRED. Uma operação de envio pertence a um só tipo. Cada tipo gravado é auditado com o antes e o depois.
 */
async function putTypes(tenant, actor, body, transaction) {
  await ensureTypes(tenant, transaction);
  const incoming = normalizeBody(body);
  const current = await repo.list(tenant, transaction);
  const byCode = new Map(current.map((t) => [t.code, t]));
  const owners = new Map();
  for (const t of current) if (!incoming.some((i) => i.code === t.code)) t.operations.forEach((op) => owners.set(op, t.code));
  for (const t of incoming) {
    const operations = t.operations === undefined ? (byCode.get(t.code) || { operations: [] }).operations : t.operations;
    t.operations = operations;
    for (const op of operations) {
      if (owners.has(op) && owners.get(op) !== t.code) throw errors.invalid(`A operação "${op}" já pertence ao tipo ${owners.get(op)}.`, { operation: op, type: owners.get(op) });
      owners.set(op, t.code);
    }
  }
  const saved = [];
  for (const t of incoming) {
    const row = await repo.upsert(tenant, t, transaction);
    saved.push(row);
    await registrarAuditoria({
      groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actor && actor.userId, action: AUDIT.TYPE, entityType: AUDIT_ENTITY.TYPE, entityId: row.id,
      beforeJson: byCode.has(t.code) ? { ...byCode.get(t.code), updatedAt: undefined } : null, afterJson: { ...row, updatedAt: undefined }, reason: `Tipo de operação externa ${t.code} gravado.`,
    }, transaction);
  }
  return { types: saved.map(view) };
}

module.exports = { listTypes, putTypes };
