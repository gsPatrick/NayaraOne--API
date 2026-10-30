'use strict';

const { SCOPES, STATES, SOURCES } = require('./flags.constants');
const { ENVIRONMENT_KEY } = require('./flags.environment');
const { liveValues } = require('./flags.settings.adapter');
const repo = require('./flags.repository');

const inValidity = (row, now) => (!row.valid_from || now >= new Date(row.valid_from).getTime()) && (!row.valid_until || now < new Date(row.valid_until).getTime());

/** Referência que cada escopo precisa casar para valer na resolução. */
function matches(row, tenant, ref) {
  switch (row.scope) {
    case 'GLOBAL': return true;
    case 'ENVIRONMENT': return Boolean(ref.environment) && row.scope_ref === String(ref.environment).toUpperCase();
    case 'GROUP': return row.scope_ref === tenant.groupId;
    case 'COMPANY': return row.scope_ref === tenant.companyId;
    case 'SECTOR': return Boolean(ref.sector) && row.scope_ref === String(ref.sector);
    case 'USER': return Boolean(ref.userId) && row.scope_ref === String(ref.userId);
    default: return false;
  }
}

/**
 * flags.resolve(tenant, key, ref, transaction, { defaultValue, now }) — M9-D870 §3.2.1. O escopo MAIS ESPECÍFICO vigente vence
 * (USER > SECTOR > COMPANY > GROUP > ENVIRONMENT > GLOBAL); entrada fora da validade (now < valid_from ou now >= valid_until) ou EXPIRED é ignorada e vale a seguinte,
 * ou o padrão do código. `ref` = { userId, sector, environment }; o ambiente padrão é o da instalação. Devolve valor, versão e origem do escopo.
 */
async function resolve(tenant, key, ref, transaction, { defaultValue = null, now = new Date() } = {}) {
  const scopeRef = { ...(ref || {}) };
  if (!scopeRef.environment) scopeRef.environment = await ENVIRONMENT_KEY.read(tenant, transaction);
  const at = now.getTime();
  const live = (await repo.candidates(tenant, key, transaction))
    .filter((row) => row.state === STATES.ACTIVE && inValidity(row, at) && matches(row, tenant, scopeRef))
    .sort((a, b) => SCOPES.indexOf(b.scope) - SCOPES.indexOf(a.scope));
  const winner = live[0];
  if (!winner) return { key, found: false, value: defaultValue, version: null, origin: { scope: 'DEFAULT', scopeRef: null, entryId: null }, kind: null, risk: null };
  let value = winner.value;
  if (winner.source === SOURCES.TENANT_SETTING) {
    const lives = await liveValues(tenant, [winner.key], transaction);
    if (lives.has(winner.key)) value = lives.get(winner.key);
  }
  return { key, found: true, value, version: winner.version, origin: { scope: winner.scope, scopeRef: winner.scope_ref, entryId: winner.id }, kind: winner.kind, risk: winner.risk };
}

module.exports = { resolve };
