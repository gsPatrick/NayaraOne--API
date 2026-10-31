'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const flagsRepo = require('../../core-governance/feature-flags/flags.repository');
const flagsService = require('../../core-governance/feature-flags/feature-flags.service');
const raci = require('../raci/raci.service');
const { registerProtectedKeys } = require('../../core-governance/feature-flags/flags.protected');
const { flagKey, flagDescription, ACTIVITY, isCanaryFlagKey, FLAG_OWNER } = require('./canary.constants');

// N1: a API genérica de flags não escreve o estado do canary; só este arquivo (gate, blockers, RACI e MFA ficam no caminho do avanço e da reversão).
registerProtectedKeys(FLAG_OWNER, {
  test: isCanaryFlagKey,
  message: 'O estado do canary de um setor só muda pelo avanço ou pela reversão do setor na migração, que conferem pendências, comparação, responsáveis e MFA.',
});

/**
 * A flag do setor é a ÚNICA fonte do estado do canary (M9-D904 §3.4): `migracao.setor.<setor>.novo_sistema`, escopo SECTOR, risco CRITICAL, valor INTEGER = percentual atual.
 * O registro (M9-D870) só aceita FLAG booleana; um valor inteiro é uma entrada do tipo CONFIG da mesma tabela de chaves (DI-D904-1).
 */
const readEntry = (tenant, sector, transaction) => flagsRepo.findBySlot(tenant, 'CONFIG', flagKey(sector), 'SECTOR', sector, transaction);

const percentOf = (row) => (row && Number.isInteger(Number(row.value)) ? Number(row.value) : 0);

/** Trava o setor até o fim da transação: dois avanços ou rollbacks do mesmo setor nunca correm juntos, nem criam a flag duas vezes. */
async function lockSector(tenant, sector, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:name))', { type: QueryTypes.SELECT, transaction, replacements: { name: `migration.canary:${tenant.companyId}:${sector}` } });
}

/** Responsável pela flag: o A da atividade SECTOR_ACTIVATION do RACI quando é uma pessoa; senão quem executa a ação. */
async function ownerFor(tenant, actorUserId, transaction) {
  const matrix = await raci.getMatrix(tenant, transaction);
  const accountable = ((matrix.activities.find((activity) => activity.code === ACTIVITY) || {}).entries || []).find((entry) => entry.raci === 'A' && entry.userId);
  return accountable ? accountable.userId : actorUserId;
}

async function ensureEntry(tenant, sector, actorUserId, transaction) {
  const found = await readEntry(tenant, sector, transaction);
  if (found) return found;
  await flagsService.createEntry(tenant, {
    key: flagKey(sector), kind: 'CONFIG', valueType: 'INTEGER', value: 0, ownerUserId: await ownerFor(tenant, actorUserId, transaction),
    scope: 'SECTOR', scopeRef: sector, risk: 'CRITICAL', description: flagDescription(sector), reason: `Flag do canary do setor ${sector} criada.`,
  }, actorUserId, transaction, { owner: FLAG_OWNER });
  return readEntry(tenant, sector, transaction);
}

/** Grava o novo percentual pelo serviço do registro (versão anterior guardada e auditoria da flag, com o motivo). */
async function writePercent(tenant, entry, percent, reason, actorUserId, transaction) {
  await flagsService.updateEntry(tenant, { id: entry.id, value: percent, reason }, actorUserId, transaction, { owner: FLAG_OWNER });
  return flagsRepo.findById(tenant, 'CONFIG', entry.id, transaction);
}

module.exports = { readEntry, percentOf, lockSector, ensureEntry, writePercent };
