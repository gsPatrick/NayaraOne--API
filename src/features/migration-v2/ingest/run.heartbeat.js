'use strict';

const { openTenantTx } = require('../../core-governance/data-quality/retention.tenantTx');
const { getSetting } = require('../../settings/settings.service');
const { KEYS, INGEST_SETTING_DEFAULTS } = require('./ingest.settings');
const runs = require('./run.repository');

/**
 * Sinal de vida do registro de controle de um replay (M9-D900, R4-L6): enquanto o replay roda, o processo renova `heartbeat_at` a cada `migracao.execucao.sinal_vida_s` segundos.
 * O registro só expira quando o sinal para (processo caído), não por duração: um replay legítimo e longo mantém a vaga. Devolve a função que encerra o sinal. Falha ao renovar
 * não derruba o replay (o próximo ciclo tenta de novo).
 */
async function start(tenant, id) {
  const seconds = Number(await openTenantTx(tenant, (transaction) => getSetting(KEYS.EXEC_HEARTBEAT_S, tenant, transaction, INGEST_SETTING_DEFAULTS[KEYS.EXEC_HEARTBEAT_S]))) || INGEST_SETTING_DEFAULTS[KEYS.EXEC_HEARTBEAT_S];
  const timer = setInterval(() => { openTenantTx(tenant, (transaction) => runs.touch(tenant, id, transaction)).catch(() => {}); }, seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start };
