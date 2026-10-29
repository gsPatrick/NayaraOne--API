'use strict';

// M9-D680 — tec.queues_dlq e tec.integration_errors: reproduzem o número só com as linhas-fonte (outbox, inbox, provider_health), ficam STALE/INCOMPLETE conforme a regra de qualidade e
// obedecem aos parâmetros (fila sem medição, janela de erro). Detalhe por fornecedor com os 9 valores.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d680Env');
const oracle = require('../_helpers/m9d680Oracle');
const clock = require('../../../src/features/analytics/metrics/clock');

let env;
before(async () => {
  env = await kit.setup();
  await kit.seedSources(env, env.cX);
  await kit.hourlyProbes(env);
  await kit.rebuild(env.cX);
});
after(() => kit.teardown(env));

const run = async () => { await kit.rebuild(env.cX); return (await kit.kpis(env.cX)).tech.kpis; };

const MINE = ['crm.x', 'finance.y', 'm9d628-consumer'];

test('m9d680 reproduz tec.queues_dlq a partir dos registros-fonte', async () => {
  const want = await oracle.queues(env, env.cX, kit.NOW, MINE);
  assert.deepEqual(want, { depth: 5, dlq: 3, oldestSeconds: 4 * 3600 }, 'a conta à mão: 3 no outbox + 2 na inbox; DLQ 2 + 1; o mais antigo entrou às 11:00Z e a medição é das 15:00Z');
  const r = (await run())['tec.queues_dlq'];
  const mine = r.details.byQueue.filter((q) => MINE.includes(q.eventType));
  const sum = (field) => mine.reduce((acc, q) => acc + Number(q[field]), 0);
  assert.deepEqual([sum('depth'), sum('dlqDepth'), Math.max(...mine.map((q) => Number(q.oldestAgeSeconds)))], [want.depth, want.dlq, want.oldestSeconds]);
  assert.equal(r.status, 'OK');
  assert.ok(Number(r.value) >= want.depth, 'o total inclui também os eventos que o próprio BI publica no outbox');
  assert.deepEqual([r.details.oldestAgeSeconds, r.details.dlqDepth], [String(want.oldestSeconds), String(want.dlq)], 'os mais antigos e a DLQ do cenário dominam os totais');
  const outbox = mine.find((q) => q.queue === 'outbox' && q.eventType === 'crm.x');
  assert.deepEqual([outbox.depth, outbox.dlqDepth, outbox.oldestAgeSeconds], ['3', '1', '14400']);
  assert.equal(Number(await kit.dimension(env.cX, 'tec.queues_dlq', 'dlq_qtd')), Number(r.details.dlqDepth));
});

test('m9d680 tec.queues_dlq sem medição há mais de 15 minutos fica STALE (parâmetro) e mantém o valor da última medição', async () => {
  clock.setClock(new Date(kit.NOW.getTime() + 20 * 60000));
  try {
    const r = (await kit.kpis(env.cX)).tech.kpis['tec.queues_dlq'];
    assert.deepEqual([r.status, r.details.reason, r.details.measurementAgeMinutes], ['STALE', 'FILA_SEM_MEDICAO', '20']);
    assert.ok(r.value !== null && Number(r.value) >= 5, 'o valor da última medição continua');
    await kit.setSetting(env, env.cX, 'analytics.tec.fila_sem_medicao_min', 30);
    assert.equal((await kit.kpis(env.cX)).tech.kpis['tec.queues_dlq'].status, 'OK', 'com o limite em 30 minutos, 20 minutos ainda vale');
  } finally {
    clock.setClock(kit.NOW);
    await kit.setSetting(env, env.cX, 'analytics.tec.fila_sem_medicao_min', 15);
  }
});

test('m9d680 reproduz tec.integration_errors a partir dos registros-fonte', async () => {
  const want = await oracle.integrations(env, env.cX, 60);
  assert.deepEqual(want, { calls: 200, errors: 12, value: '6.00' }, 'a conta à mão: 100 chamadas com 10 erros e 100 com 2 (a janela antiga e a connection DRAFT ficam de fora)');
  const r = (await run())['tec.integration_errors'];
  assert.deepEqual([r.status, r.value, r.details.calls, r.details.errors, r.details.providersAboveLimit], ['OK', want.value, '200', '12', '1']);
  const sandbox = r.details.byProvider.find((p) => p.provider === 'messaging-sandbox' && p.environment === 'SANDBOX');
  assert.deepEqual(
    [sandbox.family, sandbox.successRate, sandbox.latencyP95Ms, sandbox.latencyP99Ms, sandbox.rateLimitCount, sandbox.authFailures, sandbox.retries, sandbox.dlq, sandbox.backlog, sandbox.quotaRemaining],
    ['MESSAGING', '90.00', '300', '900', '2', '1', '5', '1', '3', '50'], 'os 9 valores de saúde do fornecedor, por ambiente e família'
  );
  const portal = r.details.providers.find((p) => p.provider === 'portal-sandbox');
  assert.deepEqual([portal.calls, portal.errorPct, portal.above], ['0', null, false]);
  assert.equal(Number(await kit.dimension(env.cX, 'tec.integration_errors', 'provider:messaging-sandbox:erro_pct')), 6);
});

test('m9d680 tec.integration_errors fica INCOMPLETE com valor nulo quando não há chamadas na janela, e a janela é parâmetro', async () => {
  await kit.setSetting(env, env.cX, 'analytics.tec.janela_minutos', 1440);
  try {
    const none = (await run())['tec.integration_errors'];
    assert.deepEqual([none.status, none.value, none.details.reason], ['INCOMPLETE', null, 'SEM_CHAMADAS']);
    await kit.setSetting(env, env.cX, 'analytics.tec.janela_minutos', 5);
    const five = (await run())['tec.integration_errors'];
    const want = await oracle.integrations(env, env.cX, 5);
    assert.deepEqual([five.status, five.value], ['OK', want.value], 'a janela de 5 minutos: 4 chamadas, 1 erro = 25,00%');
    assert.equal(want.value, '25.00');
  } finally {
    await kit.setSetting(env, env.cX, 'analytics.tec.janela_minutos', 60);
  }
});
