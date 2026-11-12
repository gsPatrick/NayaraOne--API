'use strict';

// DI-BI-1 — tec.availability: no dia em que a série de uma sonda começa, as esperadas contam a partir da primeira medição (antes dela a sonda não existia, então não há
// "sonda ausente"). Caso real da homologação: as sondas começaram às 13:38 de 03/11 e o dia inteiro contava como ausente (818 de 1.440 por sonda), o que deixava a
// disponibilidade "Dado incompleto" (7,29% de ausentes em 10/11, acima dos 5%) até 14/11 por volta das 11:09 de SP, se nenhuma sonda falhasse (evidência 70 do relato
// m9-bi-tecnologia.md). Perto da borda da retenção o dia volta a contar inteiro.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d680Env');

let env;
const CODE = 'tec.availability';
const H = 3600000;
// 15:10 de 27/10 em São Paulo (18:10Z) até 11:10 de 28/10 (14:10Z), uma sonda por hora: 9 no dia 27 e 12 no dia 28, todas ok
const SERIES = Array.from({ length: 21 }, (_, i) => new Date(Date.UTC(2026, 9, 27, 18, 10) + i * H));

before(async () => {
  env = await kit.setup();
  for (const t of [env.cX, env.cY]) {
    await kit.setSetting(env, t, 'analytics.tec.sondas', 'API');
    await kit.setSetting(env, t, 'analytics.tec.intervalo_sonda_s', 3600);
  }
  await kit.setSetting(env, env.cY, 'analytics.tec.sinais_retencao_dias', 1); // a primeira medição guardada está na borda da limpeza
  for (const at of SERIES) await kit.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: at });
  await kit.rebuild(env.cX);
  await kit.rebuild(env.cY);
});
after(() => kit.teardown(env));

const rowsOf = async (t) => (await kit.content(env, 'rm_tech_availability', t)).map((r) => [r.day, r.checks, r.expected]);

test('m9bi disponibilidade: no dia em que a série começa as esperadas contam da primeira medição, não da meia-noite', async () => {
  assert.deepEqual(await rowsOf(env.cX), [['2026-10-27', '9', '9'], ['2026-10-28', '12', '12']], '15:10 a 24:00 = 8h50 = 9 sondas horárias; hoje 00:00 a 12:00 = 12');
  const r = (await kit.kpis(env.cX)).tech.kpis[CODE];
  assert.deepEqual([r.status, r.value, r.details.expected, r.details.missingProbes], ['OK', '100.00', '21', '0']);
});

test('m9bi disponibilidade: perto da borda da retenção a primeira medição guardada não marca início de série e o dia conta inteiro', async () => {
  assert.deepEqual(await rowsOf(env.cY), [['2026-10-27', '9', '24'], ['2026-10-28', '12', '12']], 'com 1 dia de retenção a sonda mais antiga pode ser só a que sobrou da limpeza');
  const r = (await kit.kpis(env.cY)).tech.kpis[CODE];
  assert.deepEqual([r.status, r.value, r.details.reason], ['DEGRADED', null, 'SONDAS_AUSENTES'], '15 de 36 ausentes (41,67%) passam dos 5%');
});

test('m9bi disponibilidade: sonda que falta DEPOIS do início da série continua ausente', async () => {
  await env.admin.query("DELETE FROM analytics.tech_signal_log WHERE kind = 'PROBE' AND occurred_at = :at", { replacements: { at: SERIES[12] } }); // 03:10 de 28/10 em São Paulo
  try {
    await kit.rebuild(env.cX);
    assert.deepEqual(await rowsOf(env.cX), [['2026-10-27', '9', '9'], ['2026-10-28', '11', '12']]);
    const r = (await kit.kpis(env.cX)).tech.kpis[CODE];
    assert.deepEqual([r.status, r.value, r.details.missingProbes], ['OK', '95.24', '1'], '20 de 21 esperadas; 1 ausente (4,76%) dentro do limite');
  } finally {
    await kit.signal(env, { kind: 'PROBE', probe: 'API', ok: true, occurredAt: SERIES[12] });
  }
});
