'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const { PASS_ENVIRONMENTS } = require('./killSwitch.constants');

const q = (sql, transaction, replacements) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction, replacements });

/** Kill switches da empresa (flags com is_kill_switch). `onlyActive`: só os que não expiraram. */
const listSwitches = (tenant, transaction, { onlyActive = true, lock = false } = {}) => q(
  `SELECT * FROM governance.feature_flags WHERE company_id = :companyId AND is_kill_switch = true${onlyActive ? " AND state = 'ACTIVE'" : ''} ORDER BY key, scope, COALESCE(scope_ref, '')${lock ? ' FOR UPDATE' : ''}`,
  transaction, { companyId: tenant.companyId }
);

/** Linhas do registro marcadas como kill switch sem probe cadastrado (a consulta do inventário, M9-D872 §3.3). */
const withoutProbe = (tenant, transaction) => q(
  "SELECT id, key, probe FROM governance.feature_flags WHERE company_id = :companyId AND is_kill_switch = true AND (probe IS NULL OR probe = '') ORDER BY key",
  transaction, { companyId: tenant.companyId }
);

/** Último PASS (HOMOLOG/DEV) da versão do probe (`probeVersion` nulo = de qualquer versão): o que vale para o switch de qualquer ambiente. */
async function lastPass(tenant, key, probeVersion, transaction) {
  const rows = await q(
    `SELECT max(executed_at) AS at FROM governance.kill_switch_drills
      WHERE company_id = :companyId AND flag_key = :key AND result = 'PASS' AND (CAST(:version AS text) IS NULL OR probe_version = :version) AND environment IN (:envs)`,
    transaction, { companyId: tenant.companyId, key, version: probeVersion, envs: PASS_ENVIRONMENTS }
  );
  return rows[0] && rows[0].at ? new Date(rows[0].at) : null;
}

/** Existe um teste (PASS ou FAIL, não interrompido) deste switch no dia de Brasília `dayKey`? Limita o drill a um por switch e dia. */
async function drilledOnDay(tenant, key, dayKey, transaction) {
  const rows = await q(
    `SELECT 1 AS hit FROM governance.kill_switch_drills
      WHERE company_id = :companyId AND flag_key = :key AND result IN ('PASS','FAIL') AND evidence->>'interrupted' IS NULL
        AND (executed_at AT TIME ZONE 'America/Sao_Paulo')::date = CAST(:day AS date) LIMIT 1`,
    transaction, { companyId: tenant.companyId, key, day: dayKey }
  );
  return rows.length > 0;
}

const hasRunning = async (tenant, key, transaction) => (await q(
  "SELECT 1 AS hit FROM governance.kill_switch_drills WHERE company_id = :companyId AND flag_key = :key AND result = 'RUNNING' LIMIT 1", transaction, { companyId: tenant.companyId, key }
)).length > 0;

async function insertDrill(tenant, e, transaction) {
  const rows = await q(
    `INSERT INTO governance.kill_switch_drills (group_id, company_id, flag_id, flag_key, executed_at, environment, previous_state, probe_version, result)
     VALUES (:groupId, :companyId, :flagId, :key, :at, :env, :previous, :version, 'RUNNING') RETURNING *`,
    transaction, { groupId: tenant.groupId, companyId: tenant.companyId, flagId: e.flagId, key: e.key, at: e.at, env: e.environment, previous: e.previous, version: e.probeVersion }
  );
  return rows[0];
}

const finishDrill = (tenant, id, result, evidence, at, transaction) => q(
  `UPDATE governance.kill_switch_drills SET result = :result, evidence = CAST(:evidence AS jsonb), finished_at = :at
    WHERE id = :id AND company_id = :companyId RETURNING *`,
  transaction, { id, companyId: tenant.companyId, result, evidence: JSON.stringify(evidence), at }
).then((rows) => rows[0]);

/** Testes que ficaram RUNNING há mais que a tolerância (o processo caiu no meio), com trava de linha. */
const listInterrupted = (tenant, before, transaction) => q(
  "SELECT * FROM governance.kill_switch_drills WHERE company_id = :companyId AND result = 'RUNNING' AND executed_at < :before ORDER BY executed_at FOR UPDATE",
  transaction, { companyId: tenant.companyId, before }
);

const setVerification = (tenant, flagId, state, transaction) => q(
  'UPDATE governance.feature_flags SET verification_state = :state WHERE id = :id AND company_id = :companyId RETURNING id', transaction, { id: flagId, companyId: tenant.companyId, state }
);

module.exports = { listSwitches, withoutProbe, lastPass, drilledOnDay, hasRunning, insertDrill, finishDrill, listInterrupted, setVerification };
