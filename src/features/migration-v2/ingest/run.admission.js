'use strict';

const errors = require('./ingest.errors');
const runs = require('./run.repository');
const { getSetting } = require('../../settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('./ingest.settings');

const setting = async (key, tenant, transaction) => Number(await getSetting(key, tenant, transaction, INGEST_SETTING_DEFAULTS[key]));

/**
 * Admissão de uma leitura do legado (execução pedida ou replay de lote; auditoria M3 e N3). Serializa os pedidos da empresa e recusa com 409 `GOV_MIG_RUN_ALREADY_ACTIVE` quando a
 * mesma fonte já tem `migracao.execucao.max_por_fonte` ativas, ou com 429 `GOV_MIG_RUN_LIMIT` acima de `migracao.execucao.max_por_empresa`. Roda na transação do chamador.
 */
async function assertRoom(tenant, { sourceSystem, entity }, transaction) {
  await runs.lockCompany(tenant, transaction);
  // replay interrompido não segura a vaga até o prazo longo da execução (R3-L6): vencido o prazo do replay, o registro vira FAILED antes da contagem
  await runs.expireStaleReplays(tenant, await setting(KEYS.EXEC_REPLAY_EXPIRE_MIN, tenant, transaction), transaction);
  const active = await runs.countActive(tenant, { sourceSystem, entity, expireMinutes: await setting(KEYS.EXEC_EXPIRE_MIN, tenant, transaction) }, transaction);
  if (active.overlapping >= await setting(KEYS.EXEC_PER_SOURCE, tenant, transaction)) throw errors.runAlreadyActive();
  if (active.total >= await setting(KEYS.EXEC_PER_COMPANY, tenant, transaction)) throw errors.runLimit();
}

/** Admite um replay: confere a vaga da fonte e da empresa e grava o registro de controle (REPLAY, RUNNING) na mesma transação. Devolve a linha. */
async function admitReplay(tenant, actor, { sourceSystem, entity }, transaction) {
  await assertRoom(tenant, { sourceSystem, entity }, transaction);
  return runs.insertReplay(tenant, { sourceSystem, entity, requestedBy: actor.userId }, transaction);
}

module.exports = { assertRoom, admitReplay };
