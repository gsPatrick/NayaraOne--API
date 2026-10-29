'use strict';

const { BankAccount } = require('../../../models');
const { findCompanyUser } = require('../governance.users');
const { assertEvidenceForCriticalChange } = require('./evidence.guard');
const { personEntity, propertyEntity, bankAccountEntity } = require('./evidence.entities');
const { comparable } = require('./evidence.criticalFields');
const { FIELDS } = require('./bulk.fields');
const { RECORD_TYPES } = require('./bulk.constants');
const { countMatches, loadMatches } = require('./bulk.select');
const repository = require('./bulk.repository');
const errors = require('./bulk.errors');
const { assigneeInactive } = require('./data-quality.errors');

const BANK_CURRENT = ['bankCode', 'agency', 'accountNumber', 'pixKey'];

/** { campo: { before, after } } só dos campos de `target` que mudam de fato (nulo e texto vazio são o mesmo "sem valor"). */
function diffOf(patch, spec, target, current) {
  const fields = {};
  for (const [name, value] of Object.entries(patch)) {
    if (spec[name].target === target && comparable(current[name]) !== comparable(value)) fields[name] = { before: current[name] === undefined ? null : current[name], after: value };
  }
  return fields;
}

const valuesOf = (fields) => Object.fromEntries(Object.entries(fields).map(([name, change]) => [name, change.after]));

/** Alterações dos cadastros em si (pessoa, fornecedor ou imóvel): campos do próprio registro. */
async function recordChange(entityType, row, fields, ctx) {
  const isProperty = entityType === 'PROPERTY';
  const current = isProperty ? { registryNumber: row.registryNumber } : { legalName: row.legalName, birthOrFoundationDate: row.birthOrFoundationDate, taxIdNormalized: row.taxIdNormalized };
  const entity = isProperty ? propertyEntity(row, current) : await personEntity(row, current, ctx.transaction);
  return { recordType: isProperty ? RECORD_TYPES.PROPERTY : RECORD_TYPES.PERSON, instance: row, entity, fields };
}

async function bankChanges(tenant, row, patch, spec, ctx) {
  const accounts = await BankAccount.findAll({ where: { ownerPersonId: row.id, companyId: tenant.companyId }, order: [['id', 'ASC']], transaction: ctx.transaction, lock: ctx.lock ? ctx.transaction.LOCK.UPDATE : undefined });
  const out = [];
  for (const account of accounts) {
    const current = Object.fromEntries([...BANK_CURRENT, 'ownerPersonId'].map((name) => [name, account[name]]));
    const fields = diffOf(patch, spec, 'bank', current);
    if (Object.keys(fields).length) out.push({ recordType: RECORD_TYPES.BANK_ACCOUNT, instance: account, entity: await bankAccountEntity(account, current, ctx.transaction), fields });
  }
  return out;
}

async function reviewChanges(tenant, entityType, rows, patch, ctx) {
  if (!('assignedStewardId' in patch)) return [];
  const items = await repository.lockOpenReviewItems(tenant, entityType, rows.map((row) => row.id), ctx.transaction);
  return items.filter((item) => comparable(item.assigned_steward_id) !== comparable(patch.assignedStewardId))
    .map((item) => ({ recordType: RECORD_TYPES.REVIEW_ITEM, instance: item, entity: null, fields: { assignedStewardId: { before: item.assigned_steward_id, after: patch.assignedStewardId } } }));
}

/** O curador indicado precisa ser usuário ativo da empresa (mesma regra da designação por domínio, D804). */
async function assertSteward(tenant, patch, transaction) {
  if (!patch.assignedStewardId) return;
  const user = await findCompanyUser(patch.assignedStewardId, tenant, transaction);
  if (!user.exists || !user.active) throw assigneeInactive();
}

/** Aplica o guard de evidência da D807 ao registro (uma evidência vale para o lote todo); em modo `collect` guarda o impedimento em vez de lançar. */
async function guard(change, parsed, ctx, blockers) {
  if (!change.entity) return;
  try {
    change.assertion = await assertEvidenceForCriticalChange(change.entity, valuesOf(change.fields), parsed.evidence, { transaction: ctx.transaction, actorUserId: ctx.actorUserId });
  } catch (err) {
    if (!ctx.collect || !String(err.code).startsWith('GOV_EVIDENCE')) throw err;
    if (!blockers.some((b) => b.code === err.code)) blockers.push({ code: err.code, message: err.message });
  }
}

/**
 * Monta o lote ANTES de gravar qualquer coisa (M9-D808 §3.1): conta quem casa com o filtro (teto), trava os registros FOR UPDATE em ordem de id,
 * calcula o que muda em cada um (cadastro, contas bancárias ou itens da fila) e passa cada alteração crítica pelo guard de evidência da D807. Qualquer
 * recusa sobe daqui, com nada gravado. `ctx` = { transaction, actorUserId, lock, collect, max }; em `collect` (rota /impact) os impedimentos voltam em `blockers`.
 */
async function buildPlan(tenant, parsed, ctx) {
  const blockers = [];
  const matched = await countMatches(tenant, parsed.entityType, parsed.filter, ctx.transaction);
  if (matched > ctx.max) {
    const error = errors.tooLarge({ matched, limit: ctx.max });
    if (!ctx.collect) throw Object.assign(error, { blockedDetails: { matched, limit: ctx.max } });
    return { matched, changes: [], blockers: [{ code: error.code, message: error.message }] };
  }
  await assertSteward(tenant, parsed.patch, ctx.transaction);
  const rows = await loadMatches(tenant, parsed.entityType, parsed.filter, ctx);
  const spec = FIELDS[parsed.entityType].patch;
  const changes = [];
  for (const row of rows) {
    const fields = diffOf(parsed.patch, spec, 'record', row.get({ plain: true }));
    if (Object.keys(fields).length) changes.push(await recordChange(parsed.entityType, row, fields, ctx));
    if (parsed.entityType !== 'PROPERTY') changes.push(...await bankChanges(tenant, row, parsed.patch, spec, ctx));
  }
  changes.push(...await reviewChanges(tenant, parsed.entityType, rows, parsed.patch, ctx));
  for (const change of changes) await guard(change, parsed, ctx, blockers);
  return { matched, changes, blockers };
}

module.exports = { buildPlan, valuesOf };
