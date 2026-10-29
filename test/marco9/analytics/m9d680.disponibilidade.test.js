'use strict';

// M9-D680 — tec.availability: reproduz o número só com os sinais-fonte, fica DEGRADED com valor nulo quando faltam sondas, sonda ligada sem medição e intervalo/limite como parâmetros.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d680Env');
const oracle = require('../_helpers/m9d680Oracle');

let env;
const CODE = 'tec.availability';
const OPTS = { asOf: kit.AS_OF, now: kit.NOW, probes: ['API', 'DATABASE'] };
before(async () => {
  env = await kit.setup();
  for (const t of [env.cX, env.cY]) {
    await kit.setSetting(env, t, 'analytics.tec.sondas', 'API,DATABASE');
    await kit.setSetting(env, t, 'analytics.tec.intervalo_sonda_s', 3600);
  }
  await kit.hourlyProbes(env, { apiDown: 1 });
  await kit.rebuild(env.cX);
});
after(() => kit.teardown(env));

const kpi = async () => { await kit.rebuild(env.cX); return (await kit.kpis(env.cX)).tech.kpis[CODE]; };

test('m9d680 reproduz tec.availability a partir dos registros-fonte', async () => {
  const want = await oracle.availability(env, { ...OPTS, intervalS: 3600 });
  assert.deepEqual([want.expected, want.checks, want.up, want.value], [24, 24, 23, '95.83'], 'a conta à mão: 12 sondas por hora cheia em cada uma das duas, 1 falha');
  const r = await kpi();
  assert.deepEqual([r.status, r.value], ['OK', want.value]);
  assert.deepEqual([r.details.expected, r.details.up, r.details.failedProbes, r.details.missingProbes, r.details.minutesDown], ['24', '23', '1', '0', '60.00'], 'minutos fora do ar = 1 falha x 3600 s');
  assert.equal(r.details.availability3, '95.833');
  assert.equal(Number(await kit.dimension(env.cX, CODE, 'sonda:API:disponibilidade_pct')), 91.67);
  const read = await kit.readKpi(env.cX, CODE);
  assert.equal(Number(read.value), Number(want.value), 'o valor lido pela API é o do snapshot');
});

test('m9d680 tec.availability fica DEGRADED com valor nulo quando a regra de qualidade falha', async () => {
  await kit.setSetting(env, env.cX, 'analytics.tec.intervalo_sonda_s', 1800); // o dobro de sondas esperadas: metade ausente
  try {
    const want = await oracle.availability(env, { ...OPTS, intervalS: 1800 });
    assert.ok(want.missing * 100 > 5 * want.expected, 'o cenário viola a regra dos 5%');
    const r = await kpi();
    assert.deepEqual([r.status, r.value, r.details.reason, r.message], ['DEGRADED', null, 'SONDAS_AUSENTES', 'Dado incompleto, valor não confiável.']);
    await kit.setSetting(env, env.cX, 'analytics.tec.sondas', 'API,DATABASE,QUEUE'); // sonda ligada que nunca mediu
    await kit.setSetting(env, env.cX, 'analytics.tec.intervalo_sonda_s', 3600);
    const r2 = await kpi();
    assert.deepEqual([r2.status, r2.value, r2.details.reason, r2.details.probesWithoutData], ['DEGRADED', null, 'SONDA_SEM_MEDICAO', ['QUEUE']]);
  } finally {
    await kit.setSetting(env, env.cX, 'analytics.tec.intervalo_sonda_s', 3600);
    await kit.setSetting(env, env.cX, 'analytics.tec.sondas', 'API,DATABASE');
  }
});

test('m9d680 o limite de sondas ausentes é parâmetro do administrador', async () => {
  await kit.setSetting(env, env.cX, 'analytics.tec.intervalo_sonda_s', 1800);
  await kit.setSetting(env, env.cX, 'analytics.tec.sondas_ausentes_max_pct', 100);
  try {
    const r = await kpi();
    const want = await oracle.availability(env, { ...OPTS, intervalS: 1800 });
    assert.deepEqual([r.status, r.value], ['OK', want.value], 'com o limite em 100% o mesmo cenário deixa de ser DEGRADED, e o ausente não conta como sucesso (23 de 48)');
    assert.equal(r.details.missingProbes, String(want.missing));
  } finally {
    await kit.setSetting(env, env.cX, 'analytics.tec.intervalo_sonda_s', 3600);
    await kit.setSetting(env, env.cX, 'analytics.tec.sondas_ausentes_max_pct', 5);
  }
});

test('m9d680 sem nenhuma sonda no mês o KPI fica INCOMPLETE e sem valor', async () => {
  await env.admin.query("DELETE FROM analytics.tech_signal_log WHERE kind = 'PROBE'");
  const r = await kpi();
  assert.deepEqual([r.status, r.value, r.details.reason], ['INCOMPLETE', null, 'SEM_SONDAS']);
});
