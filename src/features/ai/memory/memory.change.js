'use strict';

const E = require('./memory.errors');
const V = require('./memory.input');
const policy = require('./memory.policy');
const repo = require('./memory.repository');
const { persistMemory, toMemory } = require('./memory.write');
const { auditMemory } = require('./memory.audit');
const { guarded } = require('./memory.save');

/** A pessoa enxerga esta linha? USER e SESSION só o dono (ou quem audita); fora disso a resposta é 404, sem revelar que existe. */
function visibleTo(ctx, row) {
  if (policy.has(ctx, 'ai:audit')) return true;
  if (row.classification === 'RESTRICTED' && !policy.has(ctx, 'ai:restricted') && !policy.has(ctx, 'ai:admin')) return false;
  return !['USER', 'SESSION'].includes(row.scope) || row.ownerUserId === ctx.userId;
}

async function loadForChange(ctx, id, transaction) {
  if (!V.isUuid(id)) throw E.notFound();
  const row = await repo.findById(ctx, id, transaction, { lock: true });
  if (!row || !visibleTo(ctx, row)) throw E.notFound();
  policy.assertCanChange(ctx, row);
  return row;
}

/**
 * Invalida uma memória vigente (ACTIVE -> INVALIDATED) com motivo. A linha continua no histórico e deixa de entrar no contexto.
 * Repetir a invalidação devolve a mesma linha (replayed). Só pessoa invalida (a NAY propõe, não decide).
 */
async function invalidateMemory(ctx, id, data, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  if (!policy.isHuman(ctx)) throw E.humanRequired();
  const reason = V.parseReason(data);
  return guarded(async () => {
    const row = await loadForChange(ctx, id, transaction);
    if (row.status === 'INVALIDATED') return { memory: toMemory(row), replayed: true };
    if (row.status !== 'ACTIVE') throw E.notActive();
    const before = toMemory(row);
    await repo.closeRow(row, { status: 'INVALIDATED', invalidatedBy: ctx.userId, invalidatedAt: now, invalidationReason: reason, updatedBy: ctx.userId }, transaction);
    const memory = toMemory(row);
    await auditMemory(ctx, 'ai.memory.invalidated', memory, before, 'Memória da NAY invalidada.', transaction);
    return { memory, replayed: false };
  });
}

/**
 * Corrige uma memória vigente: cria a próxima versão (version + 1, supersedes_id) e marca a anterior SUPERSEDED, na mesma transação.
 * Tipo, escopo, dono e agente não mudam; valor, finalidade, classificação, validade e origem podem. Passa por todas as regras da gravação.
 */
async function correctMemory(ctx, id, data, transaction, { now = new Date() } = {}) {
  V.ctxOk(ctx);
  return guarded(async () => {
    const row = await loadForChange(ctx, id, transaction);
    if (row.status !== 'ACTIVE' || row.expiresAt.getTime() <= now.getTime()) throw E.notActive();
    const body = V.isObject(data) ? data : {};
    const input = V.parseSave({
      type: row.memoryType, scope: row.scope, agentCode: row.agentCode, subjectType: row.subjectType, subjectId: row.subjectId,
      ownerUserId: row.ownerUserId, sourceType: row.sourceType, sourceId: row.sourceId, classification: row.classification, purpose: row.purpose,
      ...Object.fromEntries(['value', 'purpose', 'classification', 'expiresAt', 'validFrom', 'sourceType', 'sourceId'].filter((k) => body[k] !== undefined).map((k) => [k, body[k]])),
    });
    if (body.value === undefined) throw E.invalid('Informe o novo valor da memória.');
    const before = toMemory(row);
    const out = await persistMemory(ctx, input, transaction, {
      now, version: row.version + 1, supersedesId: row.id, auditAction: 'ai.memory.corrected', auditReason: 'Memória da NAY corrigida (nova versão).', before,
    });
    await repo.closeRow(row, { status: 'SUPERSEDED', updatedBy: ctx.userId || null }, transaction);
    return { ...out, previous: toMemory(row) };
  });
}

module.exports = { invalidateMemory, correctMemory, visibleTo };
