'use strict';

const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { findCompanyUser } = require('../governance.users');
const { isModuleEnabled } = require('../governance.module');
const { KINDS, STATES, SOURCES, AUDIT_ACTION, AUDIT_ENTITY } = require('./flags.constants');
const E = require('./flags.errors');
const { parseCreate, parsePatch, parseReason, isMissing } = require('./flags.input');
const { readFlagsParams } = require('./flags.params');
const { viewOf, snapshotOf } = require('./flags.view');
const { liveValues, absorbTenantSettings, writeThrough } = require('./flags.settings.adapter');
const repo = require('./flags.repository');

const LOCKED_FOR_SETTINGS = ['scope', 'scopeRef', 'validFrom', 'validUntil', 'temporary'];
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameTime = (a, b) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

async function assertOwnerActive(tenant, ownerUserId, transaction) {
  const owner = await findCompanyUser(ownerUserId, tenant, transaction);
  if (!owner.active) throw E.ownerInvalid();
}

/** Valor vivo de uma chave absorvida das configurações da empresa; `undefined` para as demais. */
async function liveOf(tenant, row, transaction) {
  if (row.source !== SOURCES.TENANT_SETTING) return undefined;
  return (await liveValues(tenant, [row.key], transaction)).get(row.key);
}

const audit = (tenant, kind, row, actorUserId, before, after, reason, transaction) => registrarAuditoria({
  groupId: tenant.groupId, companyId: tenant.companyId, actorUserId: actorUserId || null, action: AUDIT_ACTION, entityType: AUDIT_ENTITY[kind], entityId: row.id,
  beforeJson: before, afterJson: after, reason,
}, transaction);

/**
 * Cria uma flag ou configuração (POST /feature-flags; exige governance:flags:manage na rota). Responsável obrigatório e ativo, escopo, risco, validade e tipo do valor
 * conferidos; chave única por escopo (e entre flags e configurações). Nasce na versão 1, com auditoria. `trustedOwner`: criação interna (interruptores de degradação).
 */
async function createEntry(tenant, body, actorUserId, transaction, { trustedOwner = false } = {}) {
  const params = await readFlagsParams(tenant, transaction);
  const input = parseCreate(body, tenant, params);
  if (!trustedOwner) await assertOwnerActive(tenant, input.ownerUserId, transaction);
  const otherKind = input.kind === KINDS.FLAG ? KINDS.CONFIG : KINDS.FLAG;
  if (await repo.keyExistsInKind(tenant, otherKind, input.key, transaction)) throw E.duplicate();
  if (await repo.findBySlot(tenant, input.kind, input.key, input.scope, input.scopeRef, transaction)) throw E.duplicate();
  const row = await repo.insert(tenant, input.kind, input, actorUserId, transaction);
  await audit(tenant, input.kind, row, actorUserId, null, snapshotOf(row), (isMissing(body.reason) ? 'Chave criada no registro.' : String(body.reason).trim().slice(0, 500)), transaction);
  return viewOf(row);
}

function nextState(row, patch, now) {
  if (row.state !== STATES.EXPIRED) return row.state;
  const until = patch.validUntil;
  if (!until || until.getTime() <= now.getTime()) throw E.expired();
  return STATES.ACTIVE;
}

/**
 * Altera uma chave (PATCH /feature-flags com `id`, `reason` e os campos novos; `version` opcional como controle otimista). Valor, escopo, risco, validade, responsável ou descrição
 * novos sobem a versão em 1, guardam a versão anterior e auditam antes e depois com o motivo. PATCH sem mudança real não gera versão. Chave EXPIRED só volta a ACTIVE
 * com `validUntil` posterior a agora. Chave absorvida das configurações da empresa grava o valor também na configuração (leitores existentes seguem corretos).
 */
async function updateEntry(tenant, body, actorUserId, transaction, { now = new Date() } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (isMissing(b.id) || typeof b.id !== 'string') throw E.inputInvalid('Informe o id da chave (id).', { field: 'id' });
  const row = await repo.findAnywhere(tenant, b.id, transaction, { lock: true });
  if (!row) throw E.notFound();
  const reason = parseReason(b.reason);
  if (b.version !== undefined && b.version !== row.version) throw E.versionConflict({ currentVersion: row.version, sentVersion: b.version });
  const params = await readFlagsParams(tenant, transaction);
  const patch = parsePatch(b, row, tenant, params);
  const fromSettings = row.source === SOURCES.TENANT_SETTING;
  if (fromSettings && LOCKED_FOR_SETTINGS.some((field) => Object.prototype.hasOwnProperty.call(patch, field))) throw E.sourceLocked();
  if (('temporary' in patch || 'validUntil' in patch) && ((patch.temporary === undefined ? row.temporary : patch.temporary) && !(patch.validUntil === undefined ? row.valid_until : patch.validUntil))) throw E.expiryRequired();
  const state = nextState(row, patch, now);
  const live = await liveOf(tenant, row, transaction);
  const current = { value: live === undefined ? row.value : live, ownerUserId: row.owner_user_id, scope: row.scope, scopeRef: row.scope_ref, risk: row.risk, validFrom: row.valid_from, validUntil: row.valid_until, temporary: row.temporary, description: row.description };
  const next = { ...current, ...patch, state };
  const changed = !sameJson(next.value, current.value) || next.ownerUserId !== current.ownerUserId || next.scope !== current.scope || next.scopeRef !== current.scopeRef || next.risk !== current.risk
    || !sameTime(next.validFrom, current.validFrom) || !sameTime(next.validUntil, current.validUntil) || next.temporary !== current.temporary || next.description !== current.description || state !== row.state;
  if (!changed) return { ...viewOf(row, live), unchanged: true };
  if (next.ownerUserId !== current.ownerUserId) await assertOwnerActive(tenant, next.ownerUserId, transaction);
  if (next.scope !== current.scope || next.scopeRef !== current.scopeRef) {
    const clash = await repo.findBySlot(tenant, row.kind, row.key, next.scope, next.scopeRef, transaction);
    if (clash && clash.id !== row.id) throw E.duplicate();
  }
  const before = snapshotOf(row, live);
  await repo.insertVersion(tenant, row.kind, { ...row, value: current.value }, { replacedBy: actorUserId, reason }, transaction);
  if (fromSettings && !sameJson(next.value, current.value)) await writeThrough(tenant, row.key, next.value, actorUserId, transaction);
  const saved = await repo.update(tenant, row.kind, row.id, { ...next, version: row.version + 1 }, actorUserId, transaction);
  await audit(tenant, row.kind, saved, actorUserId, before, snapshotOf(saved), reason, transaction);
  return { ...viewOf(saved), unchanged: false };
}

/** Lista as chaves da empresa (absorvendo antes as configurações existentes); com `id`, devolve a chave e as versões anteriores. */
async function listEntries(tenant, query, actorUserId, transaction) {
  const params = await readFlagsParams(tenant, transaction);
  await absorbTenantSettings(tenant, actorUserId, params, transaction);
  const q = query || {};
  const rows = await repo.list(tenant, {
    kind: q.kind ? String(q.kind).toUpperCase() : null, scope: q.scope ? String(q.scope).toUpperCase() : null, risk: q.risk ? String(q.risk).toUpperCase() : null,
    state: q.state ? String(q.state).toUpperCase() : null, owner: q.owner || null, key: q.key || null,
  }, transaction);
  const lives = await liveValues(tenant, rows.filter((r) => r.source === SOURCES.TENANT_SETTING).map((r) => r.key), transaction);
  let items = rows.map((r) => viewOf(r, r.source === SOURCES.TENANT_SETTING && lives.has(r.key) ? lives.get(r.key) : undefined));
  if (q.id) items = items.filter((i) => i.id === q.id);
  const out = { modulo: 'feature-flags', rotulo: 'Feature flags e configuração', habilitado: await isModuleEnabled('feature-flags', tenant, transaction), fase: 'registro', total: items.length, itens: items };
  if (q.id && items[0]) out.versoes = await repo.listVersions(tenant, items[0].kind, q.id, transaction);
  return out;
}

module.exports = { createEntry, updateEntry, listEntries };
