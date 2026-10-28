'use strict';

const E = require('./knowledge.errors');
const V = require('./knowledge.validation');
const repo = require('./knowledge.repository');
const { toEntry } = require('./knowledge.mapper');
const { auditKnowledge } = require('./knowledge.audit');

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    throw E.fromDbError(err) || err;
  }
}

function assertValidity(c) {
  if (c.validFrom && c.validUntil && c.validUntil <= c.validFrom) throw E.invalid('A vigência termina antes de começar (validUntil deve ser maior que validFrom).');
}

/**
 * Cadastra conhecimento como DRAFT. Se o `factKey` já existe na empresa, nasce a próxima versão (a antiga continua no
 * histórico). Recusa credencial no conteúdo (400 AI_KNOWLEDGE_SECRET_DETECTED) e exige classificação.
 */
async function createEntry(ctx, body, transaction) {
  V.ctxOk(ctx);
  const c = V.parseContent(body);
  V.assertNoSecret(c);
  assertValidity(c);
  return guarded(async () => {
    await repo.lockFactKey(ctx, c.factKey, transaction);
    const version = await repo.nextVersion(ctx, c.factKey, transaction);
    const contentHash = V.computeContentHash(c);
    const row = await repo.insert(ctx, { ...c, version, contentHash }, transaction);
    const entry = toEntry(row);
    await auditKnowledge(ctx, 'ai.knowledge.created', entry, null, 'Conhecimento cadastrado como rascunho.', transaction);
    return entry;
  });
}

/** Edita um DRAFT (merge dos campos enviados). Qualquer outro estado: 409 AI_KNOWLEDGE_IMMUTABLE ("crie uma nova versão"). */
async function updateDraft(ctx, id, body, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  const c = V.parseContent(body, { partial: true });
  if (c.factKey !== undefined) throw E.invalid('A chave do fato não muda; cadastre outro conhecimento.');
  V.assertNoSecret(c);
  return guarded(async () => {
    const row = await repo.findById(ctx, id, transaction, { lock: true });
    if (!row) throw E.notFound();
    if (row.status !== 'DRAFT') throw E.immutable();
    const before = toEntry(row);
    const merged = {
      factKey: row.factKey, subjectType: c.subjectType ?? row.subjectType, subjectId: c.subjectId === undefined ? row.subjectId : c.subjectId,
      title: c.title ?? row.title, value: c.value === undefined ? row.factValueJson : c.value,
      bodyStructured: c.bodyStructured === undefined ? row.bodyStructured : c.bodyStructured, classification: c.classification ?? row.classification,
      validFrom: c.validFrom === undefined ? row.validFrom : c.validFrom, validUntil: c.validUntil === undefined ? row.validUntil : c.validUntil,
    };
    assertValidity(merged);
    const set = {
      subjectType: merged.subjectType, subjectId: merged.subjectId, title: merged.title, factValueJson: merged.value, bodyStructured: merged.bodyStructured ?? null,
      classification: merged.classification, validFrom: merged.validFrom, validUntil: merged.validUntil, contentHash: V.computeContentHash(merged),
      updatedBy: ctx.userId || null, lockVersion: row.lockVersion + 1,
    };
    for (const k of ['origin', 'ownerUserId', 'sourceId']) if (c[k] !== undefined) set[k] = c[k];
    await row.update(set, { transaction });
    const entry = toEntry(row);
    await auditKnowledge(ctx, 'ai.knowledge.updated', entry, before, 'Rascunho de conhecimento editado.', transaction);
    return entry;
  });
}

async function getEntry(ctx, id, transaction) {
  V.ctxOk(ctx);
  if (!V.isUuid(id)) throw E.notFound();
  const row = await repo.findById(ctx, id, transaction);
  if (!row) throw E.notFound();
  return toEntry(row);
}

/** Lista as versões da empresa (histórico completo), da chave mais antiga para a mais nova e da versão maior para a menor. */
async function listEntries(ctx, query, transaction) {
  V.ctxOk(ctx);
  const filters = V.parseFilters(query);
  return (await repo.list(ctx, filters, transaction)).map(toEntry);
}

module.exports = { createEntry, updateDraft, getEntry, listEntries, guarded };
