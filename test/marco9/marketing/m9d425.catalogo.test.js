'use strict';

// M9-D425 (teste 10) — os kill switches do Marketing estão registrados no catálogo de flags e kill switches (M9-D870/M9-D872) com o probe `marketing.kill.envio_parado`, o drill
// periódico os cobre (aciona, prova que o envio parou, restaura o estado anterior), o FAIL marca UNVERIFIED e o CI vê as chaves declaradas nos seeds.
// Postgres real (RLS FORCE), transação com rollback; o drill roda em HOMOLOG/DEV (em PROD é recusado). Só em banco descartável.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { sequelize } = require('../../../src/models');
const { withRollbackTenantTransaction } = require('../../testHelpers');
const probes = require('../../../src/features/core-governance/feature-flags/kill-switch/probes/registry');
const { runDrill } = require('../../../src/features/core-governance/feature-flags/kill-switch/killSwitch.drill');
const { runCycle } = require('../../../src/features/core-governance/feature-flags/kill-switch/killSwitch.cycle');
const { evaluate, switchesWithoutProbe } = require('../../../src/features/core-governance/feature-flags/kill-switch/killSwitch.status');
const { loadSeedFlags } = require('../../../src/features/core-governance/feature-flags/registry/registry.seeds');
const flagsResolve = require('../../../src/features/core-governance/feature-flags/flags.resolve');
const env = require('../_helpers/m9d425Env');

const { ks, q, flagRow } = env;
const NOW = new Date('2031-03-10T12:00:00Z');
const PROBE = 'marketing.kill.envio_parado';
const KEYS = ['marketing.channel.email.kill', 'marketing.channel.facebook.kill', 'marketing.channel.instagram.kill', 'marketing.channel.linkedin.kill', 'marketing.channel.portal.kill',
  'marketing.channel.site.kill', 'marketing.channel.tiktok.kill', 'marketing.channel.whatsapp.kill', 'marketing.channel.youtube.kill', 'marketing.sending.kill'];
let A;
before(async () => { ({ a: A } = await env.tenants()); });
after(() => sequelize.close());
const drillsOf = (t, key) => q(t, 'SELECT result, environment, probe_version, previous_state, evidence FROM governance.kill_switch_drills WHERE company_id = :c AND flag_key = :k ORDER BY executed_at', { c: A.companyId, k: key });

test('kill_switch_registrado_no_catalogo_d872_com_probe_e_drill', async () => {
  // o probe existe no código, com versão, e todo kill switch do Marketing aponta para ele
  const probe = probes.getProbe(PROBE);
  assert.ok(probe && probe.version && typeof probe.run === 'function');
  await withRollbackTenantTransaction(A, async (t) => {
    const rows = await ks.ensureKillSwitches(A, A.userId, t);
    assert.deepEqual(rows.map((r) => r.key).sort(), KEYS);
    assert.ok(rows.every((r) => r.is_kill_switch === true && r.risk === 'CRITICAL' && r.probe === PROBE && r.value === false && r.scope === 'COMPANY' && r.state === 'ACTIVE'));
    const orphan = (await switchesWithoutProbe(A, t)).filter((r) => r.key.startsWith('marketing.'));
    assert.deepEqual(orphan, [], 'nenhum kill switch do Marketing sem probe');
    // nunca testado: o relatório de vencimento o aponta (NEVER_PASSED); depois de um PASS deixa de estar vencido
    const global = await flagRow(t, A, 'marketing.sending.kill');
    const row = (await q(t, 'SELECT * FROM governance.feature_flags WHERE id = :id', { id: global.id }))[0];
    assert.deepEqual([(await evaluate(A, row, { now: NOW, transaction: t })).stale, (await evaluate(A, row, { now: NOW, transaction: t })).reason], [true, 'NEVER_PASSED']);
    const out = await runDrill(A, global.id, { now: NOW, environment: 'HOMOLOG', transaction: t });
    assert.equal(out.result, 'PASS', JSON.stringify(out.evidence));
    assert.deepEqual([out.evidence.detail.stateBlocked, out.evidence.detail.attempt.refused, out.evidence.detail.sent, out.evidence.detail.campaignBlocked, out.evidence.detail.automationBlocked], [true, true, 0, true, true]);
    assert.equal(out.restoredTo, false, 'o estado anterior é restaurado SEMPRE');
    assert.equal((await flagRow(t, A, 'marketing.sending.kill')).value, false);
    assert.equal((await evaluate(A, row, { now: NOW, transaction: t })).stale, false);
    assert.equal((await ks.readKillState(A, { channel: 'EMAIL' }, t)).blocked, false, 'depois do drill nada continua bloqueado');
    // o drill não deixa campanha nem fluxo de teste para trás
    assert.equal((await q(t, "SELECT count(*)::int AS n FROM marketing.campaigns WHERE company_id = :c AND code LIKE 'KP-%'", { c: A.companyId }))[0].n, 0);
    assert.equal((await q(t, "SELECT count(*)::int AS n FROM marketing.automation_flows WHERE company_id = :c AND code LIKE 'KP-%'", { c: A.companyId }))[0].n, 0);
  });
});

test('o_ciclo_diario_testa_os_dez_switches_em_homolog_e_em_prod_so_registra_a_recusa', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const count = async () => (await q(t, "SELECT count(*)::int AS n FROM governance.feature_flags WHERE company_id = :c AND key LIKE 'marketing.%.kill'", { c: A.companyId }))[0].n;
    assert.equal(await count(), 0, 'a empresa nunca acionou nenhum switch: ainda não há chave registrada');
    await ks.changeKillSwitch({ tenant: A, actorUserId: A.userId, transaction: t, input: await ks.parseChange({ scope: 'CHANNEL', targetId: 'EMAIL', active: true, reason: 'QA-M9 desligado antes do drill' }, A, t) });
    assert.equal(await count(), 1, 'só o canal acionado foi registrado');
    const prod = await runCycle(A, { now: NOW, environment: 'PROD', transaction: t });
    assert.equal(await count(), 10, 'o ciclo diário cadastra sozinho as chaves que faltam, com um só responsável ativo');
    assert.equal((await q(t, "SELECT count(DISTINCT owner_user_id)::int AS n FROM governance.feature_flags WHERE company_id = :c AND key LIKE 'marketing.%.kill' AND key <> 'marketing.channel.email.kill'", { c: A.companyId }))[0].n, 1);
    assert.ok(prod.refused.length >= 10 && prod.drills.length === 0, 'em PROD o teste automático nunca roda');
    assert.equal((await flagRow(t, A, 'marketing.channel.email.kill')).value, true, 'PROD não toca no switch');
    const homolog = await runCycle(A, { now: NOW, environment: 'HOMOLOG', transaction: t });
    const mine = homolog.drills.filter((d) => d.key.startsWith('marketing.'));
    assert.deepEqual(mine.map((d) => d.key).sort(), KEYS);
    assert.ok(mine.every((d) => d.result === 'PASS'), JSON.stringify(mine));
    // o switch que estava ligado antes do teste continua ligado depois (estado anterior restaurado), os demais seguem desligados
    assert.equal((await flagRow(t, A, 'marketing.channel.email.kill')).value, true);
    assert.equal((await flagRow(t, A, 'marketing.sending.kill')).value, false);
    const email = await drillsOf(t, 'marketing.channel.email.kill');
    assert.deepEqual([email[0].result, email[0].environment, email[0].previous_state, email[0].probe_version], ['PASS', 'HOMOLOG', true, probe().version]);
    assert.equal((await flagRow(t, A, 'marketing.sending.kill')).value === false && (await q(t, "SELECT verification_state FROM governance.feature_flags WHERE company_id = :c AND key = 'marketing.sending.kill'", { c: A.companyId }))[0].verification_state, 'VERIFIED');
  });
});

const probe = () => probes.getProbe(PROBE);

test('probe_reprova_quando_o_envio_nao_parou_e_o_switch_fica_UNVERIFIED', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    await ks.ensureKillSwitches(A, A.userId, t);
    const flag = await flagRow(t, A, 'marketing.channel.whatsapp.kill');
    const original = flagsResolve.resolve;
    flagsResolve.resolve = async (...args) => ({ ...(await original(...args)), value: false }); // "o kill switch não está valendo": o envio NÃO para
    let out;
    try { out = await runDrill(A, flag.id, { now: NOW, environment: 'DEV', transaction: t }); } finally { flagsResolve.resolve = original; }
    assert.equal(out.result, 'FAIL');
    assert.equal(out.evidence.detail.stateBlocked, false);
    assert.equal((await flagRow(t, A, 'marketing.channel.whatsapp.kill')).value, false, 'mesmo no FAIL o estado anterior é restaurado');
    assert.equal((await q(t, 'SELECT verification_state FROM governance.feature_flags WHERE id = :id', { id: flag.id }))[0].verification_state, 'UNVERIFIED');
    assert.equal((await drillsOf(t, 'marketing.channel.whatsapp.kill'))[0].result, 'FAIL');
  });
});

test('seeds_do_ci_declaram_os_dez_switches_e_o_arquivo_de_flags_esta_em_dia', () => {
  const seeds = loadSeedFlags(path.join(__dirname, '../../../src/features/core-governance/feature-flags/seeds')).filter((f) => f.domain === 'marketing');
  assert.deepEqual(seeds.map((f) => f.key).sort(), KEYS);
  assert.ok(seeds.every((f) => f.killSwitch === true && f.risk === 'CRITICAL' && f.probe === PROBE && f.temporary === false));
  const registry = require('../../../docs/governance/flags.json');
  for (const key of KEYS) assert.ok(registry.flags.some((f) => f.key === key), `${key} em docs/governance/flags.json`);
});
