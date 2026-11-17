'use strict';

// DI-BI2-9 (resposta de 16/11/2026, pendência "Indicador de filas grava dois retratos a cada recálculo", 566 revisões num dia na homologação) — tec.queues_dlq só grava
// revisão quando o retrato muda e confirma o snapshot quando não muda, como os demais indicadores. Causa: a idade da última medição das filas (relógio da leitura
// menos o instante do read model) entrava no hash do cálculo; cada passada de outro read model de Tecnologia trazia outra idade e gravava revisão nova (alternando
// uma sem confirmação e outra confirmada). Agora o hash leva o efeito da idade (fila STALE ou não), não os minutos. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./marco9/_helpers/m9d680Env');
const clock = require('../src/features/analytics/metrics/clock');
const { calcHash } = require('../src/features/analytics/metrics/calcHash');
const { hashInputsOf } = require('../src/features/analytics/metrics/kpis/calcInputs.stable');

let env;
const at = (minutes) => new Date(kit.NOW.getTime() + minutes * 60000);

async function revisions(t, code) {
  const [rows] = await env.admin.query(
    `SELECT s.revision_no, s.status, s.calc_hash, COALESCE(c.confirmations, 0) AS confirmations FROM analytics.metric_snapshots s JOIN analytics.metric_definitions d ON d.id = s.metric_id
       LEFT JOIN analytics.metric_snapshot_confirmations c ON c.snapshot_id = s.id
      WHERE s.company_id = :c AND d.metric_code = :code AND s.dimension_key = '' AND s.as_of_date = :asOf ORDER BY s.revision_no`,
    { replacements: { c: t.companyId, code, asOf: kit.AS_OF } }
  );
  return rows;
}

before(async () => {
  env = await kit.setup();
  await kit.seedSources(env, env.cX);
  await kit.hourlyProbes(env);
  clock.setClock(kit.NOW);
  await kit.rebuild(env.cX);
});
after(async () => {
  clock.setClock(kit.NOW);
  await kit.teardown(env);
});

test('DI-BI2-9 o hash troca a idade pelo efeito dela: mesma fila com 0 e 3 minutos dá o mesmo hash; STALE dá outro', () => {
  const rows = [{ queue: 'outbox', eventType: 'crm.x', depth: '3', oldestAgeSeconds: '40', dlqDepth: '1' }];
  const effect = (status) => ({ status, value: '3', dimensions: [{ key: 'dlq_qtd', value: '1' }] });
  const hashOf = (age, status) => calcHash({ metricCode: 'tec.queues_dlq', version: 1, inputs: hashInputsOf({ rows, measurementAgeMinutes: age }, ['measurementAgeMinutes'], effect(status)), params: { staleMinutes: 15 } });
  assert.equal(hashOf(0, 'OK'), hashOf(3, 'OK'));
  assert.notEqual(hashOf(3, 'OK'), hashOf(20, 'STALE'));
  assert.notEqual(calcHash({ metricCode: 'tec.queues_dlq', version: 1, inputs: { rows, measurementAgeMinutes: 0 }, params: {} }), calcHash({ metricCode: 'tec.queues_dlq', version: 1, inputs: { rows, measurementAgeMinutes: 3 }, params: {} }), 'a forma antiga mudava o hash a cada minuto');
});

test('DI-BI2-9 recálculos sem mudança na fila não gravam revisão: confirmam o snapshot (antes: uma revisão por passada)', async () => {
  const t = env.cX;
  clock.setClock(at(0));
  await kit.kpis(t);
  const first = await revisions(t, 'tec.queues_dlq');
  assert.equal(first.length, 1);
  const confirmedBefore = Number(first[0].confirmations); // a reconstrução do before() já recalculou a cada lote de read model de Tecnologia
  for (const minutes of [1, 3, 5, 9, 14]) {
    clock.setClock(at(minutes));
    await kit.kpis(t);
  }
  const after5 = await revisions(t, 'tec.queues_dlq');
  assert.equal(after5.length, 1, `cinco recálculos com a mesma fila: nenhuma revisão nova (vieram ${after5.length})`);
  assert.equal(Number(after5[0].confirmations) - confirmedBefore, 5, 'cada recálculo confirmou o snapshot');
});

test('DI-BI2-9 a fila sem medição há mais de 15 minutos grava UMA revisão STALE e as passadas seguintes só confirmam', async () => {
  const t = env.cX;
  clock.setClock(at(20));
  await kit.kpis(t);
  clock.setClock(at(21));
  await kit.kpis(t);
  clock.setClock(at(25));
  await kit.kpis(t);
  const list = await revisions(t, 'tec.queues_dlq');
  assert.deepEqual(list.map((r) => r.status), ['OK', 'STALE'], 'a mudança de estado é a única revisão nova');
  assert.equal(Number(list[1].confirmations), 2);
});
