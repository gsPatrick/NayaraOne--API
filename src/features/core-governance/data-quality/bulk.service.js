'use strict';

const { getSetting } = require('../../settings/settings.service');
const settings = require('./bulk.settings');
const errors = require('./bulk.errors');
const repository = require('./bulk.repository');
const { parseBody, parseIdempotencyKey, UUID } = require('./bulk.input');
const { buildPlan } = require('./bulk.plan');
const { applyPlan, auditLot } = require('./bulk.apply');
const { auditBlocked, recordFailure } = require('./bulk.audit');
const { lotView, itemView } = require('./bulk.view');

const read = (key, tenant, transaction) => getSetting(key, tenant, transaction, settings.BULK_SETTING_DEFAULTS[key]);
const BLOCKING = /^GOV_(BULK_TOO_LARGE|EVIDENCE_)/;

/** Lote já criado com esta chave: o mesmo pedido devolve o original; outro corpo é 422 GOV_IDEMPOTENCY_KEY_REUSED. */
function replayOf(existing, parsed) {
  if (existing.request_hash !== parsed.requestHash) throw errors.idempotencyReused();
  return { lot: lotView(existing), replayed: true };
}

/**
 * POST /data-quality/bulk-changes (M9-D808 §3.1). Tudo ou nada numa única transação: cria o lote, monta o plano (teto de registros, travas FOR UPDATE,
 * guard de evidência da D807) e só então grava, auditando cada registro. Recusas de negócio (teto, evidência) são auditadas à parte; qualquer outra falha
 * desfaz o lote inteiro, fica registrada como lote FAILED e sobe como 500 INTERNAL_ERROR. A Idempotency-Key (M9-D843) é exigida: repetir devolve o lote original.
 */
async function executeBulk(tenant, actor, body, { idempotencyKey } = {}, transaction) {
  const key = parseIdempotencyKey(idempotencyKey);
  const parsed = parseBody(body, { reasonMin: Number(await read(settings.REASON_MIN_KEY, tenant, transaction)) });
  const existing = await repository.findByKey(tenant, key, transaction);
  if (existing) return replayOf(existing, parsed);
  const lot = await repository.insertLot(tenant, actor.userId, parsed, key, transaction);
  if (!lot) return replayOf(await repository.findByKey(tenant, key, transaction), parsed);

  const ctx = { transaction, actorUserId: actor.userId, lock: true, collect: false, max: Number(await read(settings.MAX_KEY, tenant, transaction)) };
  let plan;
  try {
    plan = await buildPlan(tenant, parsed, ctx);
  } catch (err) {
    if (BLOCKING.test(String(err.code))) await auditBlocked(tenant, actor.userId, { code: err.code, entityType: parsed.entityType, filterHash: parsed.filterHash, fields: Object.keys(parsed.patch), ...(err.blockedDetails || {}) });
    throw err;
  }
  try {
    const count = await applyPlan(tenant, lot, plan, ctx);
    const saved = await repository.setAffected(lot.id, count, transaction);
    await auditLot(tenant, lot, parsed, count, ctx);
    return { lot: lotView(saved), replayed: false };
  } catch (err) {
    await recordFailure(tenant, actor.userId, parsed, key, err.message);
    throw errors.failed();
  }
}

/** POST /data-quality/bulk-changes/impact: o que o lote alteraria e o que o impede, sem gravar nada (inventário da M9-D852, linha 9). */
async function impactOf(tenant, body, transaction) {
  const parsed = parseBody(body, { reasonMin: 0 });
  const ctx = { transaction, actorUserId: null, lock: false, collect: true, max: Number(await read(settings.MAX_KEY, tenant, transaction)) };
  const plan = await buildPlan(tenant, parsed, ctx);
  const byRecordType = {};
  plan.changes.forEach((change) => { byRecordType[change.recordType] = (byRecordType[change.recordType] || 0) + 1; });
  return { counts: { records: plan.matched, willChange: plan.changes.length, byRecordType }, totalAmountCents: 0, blockers: plan.blockers };
}

async function pageOf(tenant, query, transaction) {
  const size = Number(await read(settings.PAGE_SIZE_KEY, tenant, transaction));
  const page = Number(query && query.page) || 1;
  const pageSize = Number(query && query.pageSize) || size;
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) throw errors.validation('Paginação inválida: page >= 1 e pageSize de 1 a 200.');
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/** GET /data-quality/bulk-changes/:id — o lote e seus itens (só hashes), paginados. */
async function getBulkChange(tenant, lotId, query, transaction) {
  if (typeof lotId !== 'string' || !UUID.test(lotId)) throw errors.notFound();
  const lot = await repository.getLot(tenant, lotId.toLowerCase(), transaction);
  if (!lot) throw errors.notFound();
  const paging = await pageOf(tenant, query, transaction);
  const { rows, total } = await repository.listItems(lot.id, paging, transaction);
  return { lot: lotView(lot), items: rows.map(itemView), itemsTotal: total, page: paging.page, pageSize: paging.pageSize };
}

/** GET /data-quality/bulk-changes — os lotes da empresa, do mais novo ao mais antigo. */
async function listBulkChanges(tenant, query, transaction) {
  const paging = await pageOf(tenant, query, transaction);
  const { rows, total } = await repository.listLots(tenant, paging, transaction);
  return { items: rows.map(lotView), total, page: paging.page, pageSize: paging.pageSize };
}

module.exports = { executeBulk, impactOf, getBulkChange, listBulkChanges };
