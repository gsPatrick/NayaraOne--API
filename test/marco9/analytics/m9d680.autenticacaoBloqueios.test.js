'use strict';

// M9-D680 — tec.freshness, tec.auth_failures e tec.blocked_events: reproduzem o número só com as linhas-fonte, ficam INCOMPLETE/DEGRADED com valor nulo conforme a regra de qualidade, o dia de
// São Paulo decide onde o lançamento cai (23:30 de SP) e os limiares são parâmetros.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d680Env');
const oracle = require('../_helpers/m9d680Oracle');

let env;
before(async () => {
  env = await kit.setup();
  await kit.seedSources(env, env.cX);
  await kit.hourlyProbes(env);
  await kit.rebuild(env.cX);
});
after(() => kit.teardown(env));

const run = async (asOf = kit.AS_OF) => { await kit.rebuild(env.cX); return (await kit.kpis(env.cX, asOf)).tech.kpis; };

test('m9d680 reproduz tec.freshness a partir dos registros-fonte', async () => {
  const r = (await run())['tec.freshness'];
  assert.deepEqual([r.status, r.value], ['OK', '2'], 'a conta à mão: legal 600 min (limite 240 => STALE) e rental 1200 min (limite 240 x 4 = 960 => EXPIRED); os demais em dia');
  assert.deepEqual([r.details.stale, r.details.expired], ['1', '1']);
  assert.deepEqual(r.details.worst, { readModel: 'rm_rental_m9d628', state: 'EXPIRED', ageMinutes: '1200' });
  assert.equal(Number(await kit.dimension(env.cX, 'tec.freshness', 'pior_idade_min')), 1200);
});

test('m9d680 tec.freshness: o limite do domínio é parâmetro e sem registro de atualização fica INCOMPLETE com valor nulo', async () => {
  await kit.setSetting(env, env.cX, 'analytics.freshness.max_minutos.LEGAL', 700);
  try {
    assert.equal((await run())['tec.freshness'].value, '1', 'com o limite do Jurídico em 700 minutos só o Locação continua atrasado');
  } finally { await kit.setSetting(env, env.cX, 'analytics.freshness.max_minutos.LEGAL', 240); }
  const emptyCompany = await kit.kpis(env.cY);
  assert.equal(emptyCompany.tech.kpis['tec.freshness'], undefined, 'empresa sem nenhuma atualização: o KPI nem gera snapshot (sem fonte não há número)');
});

test('m9d680 reproduz tec.auth_failures a partir dos registros-fonte', async () => {
  const want = await oracle.authFailures(env, env.cX, kit.AS_OF);
  assert.deepEqual(want, { login: 3, mfa: 1, integration: 2, total: 6 });
  const r = (await run())['tec.auth_failures'];
  assert.deepEqual([r.status, r.value], ['OK', String(want.total)]);
  assert.deepEqual(r.details.byKind.map((k) => [k.kind, k.failures, k.distinctActors]), [['LOGIN', '3', '2'], ['MFA', '1', '1'], ['INTEGRATION', '2', '1']]);
  assert.equal(Number(await kit.dimension(env.cX, 'tec.auth_failures', 'tipo:LOGIN:falhas_qtd')), 3);
});

test('m9d680 tec.auth_failures: pico acima do limiar (parâmetro) liga o alerta e sem log de autenticação fica INCOMPLETE com valor nulo', async () => {
  assert.equal((await run())['tec.auth_failures'].details.alert, false, 'o pico do cenário é 2 por hora, abaixo do padrão de 20');
  await kit.setSetting(env, env.cX, 'analytics.tec.auth_falhas_por_hora', 1);
  try {
    const r = (await run())['tec.auth_failures'];
    assert.equal(r.details.alert, true);
    assert.deepEqual(r.details.peaks.map((p) => [p.kind, p.peakHourFailures]), [['INTEGRATION', '2'], ['LOGIN', '2']]);
  } finally { await kit.setSetting(env, env.cX, 'analytics.tec.auth_falhas_por_hora', 20); }
  await env.admin.query("DELETE FROM analytics.tech_signal_log WHERE kind = 'PROBE'");
  const none = (await run())['tec.auth_failures'];
  assert.deepEqual([none.status, none.value, none.details.reason], ['INCOMPLETE', null, 'LOG_DE_AUTENTICACAO_AUSENTE']);
});

test('m9d680 tec.blocked_events fica DEGRADED com valor nulo quando há evento bloqueado sem motivo; corrigido, reproduz o número da fonte', async () => {
  const bad = (await run())['tec.blocked_events'];
  assert.deepEqual([bad.status, bad.value, bad.details.reason, bad.details.withoutReason], ['DEGRADED', null, 'EVENTO_BLOQUEADO_SEM_MOTIVO', '1']);
  await env.admin.query("UPDATE marketing.automation_runs SET blocked_reason = 'FREQUENCY_CAP' WHERE company_id = :c AND status = 'BLOCKED' AND blocked_reason IS NULL", { replacements: { c: env.cX.companyId } });
  const want = await oracle.blocked(env, env.cX, kit.AS_OF);
  assert.equal(want.total, 8, 'a conta à mão: 5 execuções de automação no dia (consentimento 2, kill switch 1, 2 outros), 2 de segurança e 1 de validação');
  const ok = (await run())['tec.blocked_events'];
  assert.deepEqual([ok.status, ok.value], ['OK', String(want.total)]);
  assert.deepEqual(ok.details.byReason, { KILL_SWITCH: '1', SECURITY_POLICY: '2', CONSENT: '2', VALIDATION: '1' });
  assert.deepEqual(ok.details.other, { FREQUENCY_CAP: '1', QUIET_HOURS: '1' });
});

test('m9d680 timezone: lançamento às 23:30 de São Paulo cai no dia certo', async () => {
  // a execução bloqueada por consentimento às 02:30Z de 28/10 é das 23:30 de 27/10 em São Paulo
  const twentySeventh = (await run('2026-10-27'))['tec.blocked_events'];
  assert.equal(twentySeventh.value, '1', 'no dia 27 há só ela');
  assert.equal(twentySeventh.details.byReason.CONSENT, '1');
  const twentyEighth = (await run('2026-10-28'))['tec.blocked_events'];
  assert.equal(twentyEighth.value, '8', 'no dia 28 ela não conta');
  assert.equal((await oracle.blocked(env, env.cX, '2026-10-27')).total, 1);
});

test('m9d680 os motivos de bloqueio conhecidos são parâmetro: o que sai da lista soma em other', async () => {
  await kit.setSetting(env, env.cX, 'analytics.tec.motivos_bloqueio_conhecidos', 'CONSENT');
  try {
    const r = (await run())['tec.blocked_events'];
    assert.deepEqual(r.details.byReason, { CONSENT: '2' });
    assert.deepEqual(r.details.other, { FREQUENCY_CAP: '1', KILL_SWITCH: '1', QUIET_HOURS: '1', SECURITY_POLICY: '2', VALIDATION: '1' });
    assert.equal(r.value, '8', 'o total não muda');
  } finally { await kit.setSetting(env, env.cX, 'analytics.tec.motivos_bloqueio_conhecidos', 'KILL_SWITCH,SECURITY_POLICY,CONSENT,VALIDATION'); }
});
