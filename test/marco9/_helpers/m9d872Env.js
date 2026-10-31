'use strict';

// Apoio dos testes M9-D872 com banco (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const env = require('./m9d871Env');
const probes = require('../../../src/features/core-governance/feature-flags/kill-switch/probes/registry');
const drill = require('../../../src/features/core-governance/feature-flags/kill-switch/killSwitch.drill');
const cycle = require('../../../src/features/core-governance/feature-flags/kill-switch/killSwitch.cycle');
const status = require('../../../src/features/core-governance/feature-flags/kill-switch/killSwitch.status');

const PROBE = 'qa.m9d872.envio_parado';
/** Comportamento do probe de teste: troque `behavior.run` em cada teste. */
const behavior = { run: null, calls: 0 };

const runner = async (ctx) => { behavior.calls += 1; return behavior.run(ctx); };
const registerTestProbe = (version = '1') => probes.registerProbe({ name: PROBE, version, description: 'Probe de teste da M9-D872.', run: runner });
/** Probe que prova que a função parou olhando o valor do switch pela resolução (acionado = true). */
const stopsWhenTriggered = (key) => async ({ tenant, transaction }) => {
  const seen = await env.resolve(tenant, key, {}, transaction);
  return { pass: seen.value === true, evidence: { observed: seen.value } };
};

const mkSwitch = (tenant, tx, over = {}) => env.mkFlag(tenant, tx, { isKillSwitch: true, risk: 'CRITICAL', probe: PROBE, value: false, ...over });
const drillsOf = (tx, key) => env.sequelize.query('SELECT * FROM governance.kill_switch_drills WHERE flag_key = :key ORDER BY executed_at', { type: 'SELECT', transaction: tx, replacements: { key } });
const insertDrill = (tenant, tx, flag, { daysAgo = 0, environment = 'HOMOLOG', result = 'PASS', version = '1', previous = false, at = null }) => env.sequelize.query(
  `INSERT INTO governance.kill_switch_drills (group_id, company_id, flag_id, flag_key, executed_at, finished_at, environment, previous_state, probe_version, result, evidence)
   VALUES (:g, :c, :id, :key, COALESCE(CAST(:at AS timestamptz), CAST(:now AS timestamptz) - make_interval(days => :days)), COALESCE(CAST(:at AS timestamptz), CAST(:now AS timestamptz) - make_interval(days => :days)), :env, :prev, :version, :result, '{}'::jsonb)`,
  { transaction: tx, replacements: { g: tenant.groupId, c: tenant.companyId, id: flag.id, key: flag.key, days: daysAgo, env: environment, prev: previous, version, result, now: env.NOW.toISOString(), at } }
);
const stateOf = async (tenant, flag, tx) => { const row = await env.repo.findAnywhere(tenant, flag.id, tx); return { value: row.value, verification: row.verification_state, version: row.version }; };

const { purgeKillSwitchResidue } = require('./killSwitchResidue');
/** Tira do banco os kill switches de teste commitados por outros arquivos (o ciclo varre todos os switches da empresa). Chamar no before. */
const isolateKillSwitches = () => purgeKillSwitchResidue();

module.exports = { ...env, isolateKillSwitches, probes, drill, cycle, status, PROBE, behavior, registerTestProbe, stopsWhenTriggered, mkSwitch, drillsOf, insertDrill, stateOf };
