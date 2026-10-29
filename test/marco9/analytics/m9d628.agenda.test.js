'use strict';

// M9-D628 — a agenda recalcula o que depende do relógio: as sondas esperadas crescem com o dia, a mesma sonda muda de dia à meia-noite de São Paulo, o intervalo e as sondas
// ligadas são parâmetros, e o job de sondas grava e expurga os sinais. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env628 = require('../_helpers/m9d628Env');
const sc = require('../_helpers/m9d628Scenario');
const { runAnalyticsTechProbeJob } = require('../../../src/engines/jobs/analyticsTechProbeJob');
const tech = require('../../../src/features/analytics/tech-signals');

let env;
before(async () => {
  env = await env628.setup();
  await sc.seedAll(env, env.tenantA);
  await env628.runSchedule(env.tenantA, env628.NOW);
});
after(() => env628.teardown(env));

const availability = async () => Object.fromEntries((await env628.content(env, 'rm_tech_availability', env.tenantA)).map((r) => [`${r.probe}/${r.day}`, r]));

test('m9d628 agenda recalcula o que depende do relógio: o esperado de hoje cresce, sem nenhum evento', async () => {
  assert.equal((await availability())['API/2026-10-28'].expected, '720');
  await env628.runSchedule(env.tenantA, new Date(env628.NOW.getTime() + 60 * 60000)); // 13:00 em São Paulo
  assert.equal((await availability())['API/2026-10-28'].expected, '780');
  await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: false, occurredAt: new Date(env628.NOW.getTime() + 30 * 60000) });
  await env628.runSchedule(env.tenantA, new Date(env628.NOW.getTime() + 60 * 60000));
  const api = (await availability())['API/2026-10-28'];
  assert.deepEqual([api.checks, api.up], ['11', '10'], 'a sonda que falhou entra na hora, e a que falhou não conta como sucesso');
});

test('m9d628 passada depois da meia-noite de São Paulo: o dia anterior fecha com o dia inteiro esperado', async () => {
  const next = new Date('2026-10-29T03:30:00Z'); // 00:30 de 29/10 em São Paulo
  await env628.runSchedule(env.tenantA, next);
  const rows = await availability();
  assert.equal(rows['API/2026-10-28'].expected, '1440');
  assert.equal(rows['DATABASE/2026-10-27'].expected, '1440');
});

test('m9d628 intervalo e janela são parâmetros do administrador', async () => {
  await env628.setSetting(env, env.tenantA, 'analytics.tec.intervalo_sonda_s', 120);
  await env628.setSetting(env, env.tenantA, 'analytics.tec.historico_dias', 1);
  try {
    await env628.runSchedule(env.tenantA, env628.NOW);
    const rows = await availability();
    assert.equal(rows['API/2026-10-28'].expected, '360', 'intervalo de 120 s: metade das sondas esperadas');
    assert.equal(rows['DATABASE/2026-10-27'], undefined, 'histórico de 1 dia: o dia anterior sai');
    await env628.setSetting(env, env.tenantA, 'analytics.tec.sondas', 'API');
    await env628.runSchedule(env.tenantA, env628.NOW);
    assert.deepEqual(Object.keys(await availability()), ['API/2026-10-28'], 'só a sonda ligada');
  } finally {
    await env.admin.query("DELETE FROM core.tenant_settings WHERE key LIKE 'analytics.tec.%'");
  }
});

test('m9d628 o job de sondas grava um sinal por sonda ligada e expurga os sinais acima da retenção', async () => {
  const old = await env628.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: new Date('2026-08-01T12:00:00Z') });
  const out = await runAnalyticsTechProbeJob({ now: env628.NOW, force: true });
  assert.deepEqual(Object.keys(out.probed).sort(), ['API', 'DATABASE', 'QUEUE', 'STORAGE']);
  assert.ok(out.probed.API && out.probed.DATABASE && out.probed.QUEUE, 'as sondas de API, banco e fila respondem no ambiente de teste');
  assert.ok(out.purged >= 1);
  const [[r]] = await env.admin.query('SELECT (SELECT count(*)::int FROM analytics.tech_signal_log WHERE id = :old) AS old, (SELECT count(*)::int FROM analytics.tech_signal_log WHERE occurred_at = :now AND kind = \'PROBE\') AS fresh', { replacements: { old, now: env628.NOW } });
  assert.deepEqual([r.old, r.fresh], [0, 4]);
  assert.equal(await tech.measure('INEXISTENTE', 100), false, 'sonda desconhecida nunca é sucesso');
});

test('m9d628 login e MFA com falha viram sinais técnicos só com hash', async () => {
  const before = (await env.admin.query('SELECT count(*)::int AS n FROM analytics.tech_signal_log WHERE kind IN (\'LOGIN_FAILURE\', \'MFA_FAILURE\')'))[0][0].n;
  assert.equal(await tech.recordLoginFailure({ email: 'Pessoa@Exemplo.com', ip: '198.51.100.7' }), true);
  assert.equal(await tech.recordMfaFailure({ userId: env.tenantA.userId, ip: '198.51.100.7' }), true);
  const [rows] = await env.admin.query('SELECT id, kind, actor_hash, ip_hash FROM analytics.tech_signal_log WHERE kind IN (\'LOGIN_FAILURE\', \'MFA_FAILURE\') ORDER BY occurred_at DESC LIMIT 2');
  assert.equal(rows.length, 2);
  for (const r of rows) { env.created.push({ table: 'analytics.tech_signal_log', id: r.id }); assert.match(r.actor_hash, /^[0-9a-f]{64}$/); assert.match(r.ip_hash, /^[0-9a-f]{64}$/); }
  assert.equal(rows.find((r) => r.kind === 'LOGIN_FAILURE').actor_hash, env628.hash('pessoa@exemplo.com'), 'o e-mail é normalizado e vira hash');
  assert.equal((await env.admin.query('SELECT count(*)::int AS n FROM analytics.tech_signal_log WHERE kind IN (\'LOGIN_FAILURE\', \'MFA_FAILURE\')'))[0][0].n, before + 2);
});
