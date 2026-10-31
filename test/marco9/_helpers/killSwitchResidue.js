'use strict';

// Limpeza de kill switches deixados COMMITADOS por testes (não é teste). Banco descartável apenas (usa DATABASE_ADMIN_URL).
// O ciclo da M9-D872 varre todos os switches da empresa; um switch de teste cujo probe só existia na memória de outro processo
// derrubaria os testes seguintes com GOV_KILL_PROBE_REQUIRED. Quem cria switch commitado chama isto no after; os testes do ciclo, no before.
const { adminQuery } = require('../../m9d801.helpers');

/** Prefixos de chave que só testes usam. */
const TEST_KEY_PATTERNS = ['qa.%'];

/** Apaga (com versões, histórico de drills e alertas) os kill switches cuja chave casa com algum padrão LIKE. Devolve quantos switches saíram. */
async function purgeKillSwitchResidue(patterns = TEST_KEY_PATTERNS) {
  const ids = (await adminQuery('SELECT id, key FROM governance.feature_flags WHERE is_kill_switch = true AND key LIKE ANY($1)', [patterns])).rows;
  if (!ids.length) return 0;
  const idList = ids.map((row) => row.id);
  const keys = ids.map((row) => row.key);
  await adminQuery('DELETE FROM governance.kill_switch_drills WHERE flag_key = ANY($1)', [keys]);
  await adminQuery('DELETE FROM governance.flag_alert_log WHERE entry_id = ANY($1)', [idList]);
  await adminQuery('DELETE FROM governance.flag_versions WHERE entry_id = ANY($1)', [idList]);
  await adminQuery('DELETE FROM governance.feature_flags WHERE id = ANY($1)', [idList]);
  return idList.length;
}

/** Planta um kill switch commitado (como o contract test fazia) cujo probe não está registrado neste processo. */
async function plantKillSwitch(tenant, key, probe = 'qa.m9d842.contrato_probe') {
  await adminQuery(
    `INSERT INTO governance.feature_flags (group_id, company_id, key, value, value_type, owner_user_id, risk, is_kill_switch, probe, description)
     VALUES ($1, $2, $3, 'false', 'BOOLEAN', $4, 'CRITICAL', true, $5, 'QA-M9 resíduo de outro teste')`,
    [tenant.groupId, tenant.companyId, key, tenant.userId, probe],
  );
}

module.exports = { purgeKillSwitchResidue, plantKillSwitch, TEST_KEY_PATTERNS };
