'use strict';

const { withSavepoint } = require('./killswitch.savepoint');
const flagsService = require('../core-governance/feature-flags/feature-flags.service');
const flagsRepo = require('../core-governance/feature-flags/flags.repository');
const { PROBE_NAME, REGISTRY_KEYS, GLOBAL_KEY } = require('./killswitch.constants');

const descriptionOf = (key) => (key === GLOBAL_KEY
  ? 'Kill switch global do Marketing: para toda ação de saída automática.'
  : `Kill switch do canal ${key.split('.')[2].toUpperCase()} do Marketing: para toda ação de saída automática neste canal.`);

/**
 * Registra no catálogo de flags e kill switches (M9-D870/M9-D872) a chave de um kill switch do Marketing para a empresa, se ainda não existir: flag COMPANY, valor desligado,
 * risco CRITICAL, `is_kill_switch`, com o probe do Marketing (killswitch.probe.js). O responsável é quem registra (a regra de dono ativo vale na edição). Devolve a linha.
 */
async function ensureSwitch(tenant, key, actorUserId, transaction) {
  const find = () => flagsRepo.findBySlot(tenant, 'FLAG', key, 'COMPANY', tenant.companyId, transaction);
  const found = await find();
  if (found) return found;
  try {
    await withSavepoint(transaction, (tx) => flagsService.createEntry(tenant, {
      key, kind: 'FLAG', value: false, ownerUserId: actorUserId, scope: 'COMPANY', scopeRef: tenant.companyId, risk: 'CRITICAL', isKillSwitch: true, probe: PROBE_NAME,
      description: descriptionOf(key), reason: 'Kill switch de Marketing registrado (M9-D425).',
    }, actorUserId, tx, { trustedOwner: true }));
  } catch (err) {
    // duas primeiras ativações ao mesmo tempo: a que perde a corrida (chave única) só relê a linha criada pela outra
    if (err.code !== 'GOV_FLAG_DUPLICATE' && err.name !== 'SequelizeUniqueConstraintError') throw err;
  }
  return find();
}

/** Registra os 10 kill switches (global + 9 canais) da empresa; idempotente. */
async function ensureAll(tenant, actorUserId, transaction) {
  const rows = [];
  for (const key of REGISTRY_KEYS) rows.push(await ensureSwitch(tenant, key, actorUserId, transaction));
  return rows;
}

module.exports = { ensureSwitch, ensureAll };
