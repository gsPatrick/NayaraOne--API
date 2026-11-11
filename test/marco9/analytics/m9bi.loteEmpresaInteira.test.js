'use strict';

// DI-BI-4 (M9-D607, M9-D696) — rajada de eventos num read model da EMPRESA INTEIRA (aggregateColumns vazio: os de Tecnologia e IA). Três execuções da NAY publicam três
// `ai.run.completed` no outbox e o despacho real os aplica num só lote. Cada evento recalcula por inteiro o agregado único da empresa, então o lote grava rows_upserted = 1, como a
// passada agendada, e a checagem de contagem (ROW_COUNT_RANGE, média dos refreshes anteriores +- 50%) passa. Na base 14217771 o lote contava 1 por evento (3 contra a média 1),
// a checagem reprovava (BLOCK) e o refresh ficava DEGRADED: os indicadores de IA saíam "não confiáveis" até a passada seguinte. Banco descartável (127.0.0.1).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../_helpers/m9d681Env');
const { publishAiEvent } = require('../../../src/features/ai/events/aiEvents.publish');
const { dispatchPendingEventsForCompany } = require('../../../src/engines/events/outbox-dispatcher');
const readModels = require('../../../src/features/analytics/read-models');

const AI_MODELS = { rm_ai_cost: 'ai_cost_row_count', rm_ai_quality: 'ai_quality_row_count', rm_ai_tool_calls: 'ai_tool_calls_row_count' }; // os três que ai.run.completed recalcula
const minutesBefore = (m) => new Date(kit.NOW.getTime() - m * 60000);

let env;
let runs;
before(async () => {
  env = await kit.setup();
  runs = [];
  for (const iso of ['2026-10-28T13:00:00Z', '2026-10-28T13:30:00Z', '2026-10-28T14:00:00Z']) {
    runs.push(await kit.runOf(env, env.cX, 'nay_diretoria', iso, '0.750000', { grounding: 'INSUFFICIENT_SOURCES' }));
  }
  // duas passadas agendadas antes da rajada: a média móvel da contagem fica em 1 (o agregado único da empresa)
  await kit.runSchedule(env.cX, minutesBefore(20));
  await kit.runSchedule(env.cX, minutesBefore(10));
});
after(async () => {
  await env.admin.query('DELETE FROM integration.outbox_events WHERE company_id IN (:ids)', { replacements: { ids: [env.cX.companyId, env.cY.companyId] } });
  await kit.teardown(env);
});

const refreshesOf = async (model, trigger) => (await env.admin.query(
  `SELECT id, status, rows_upserted, error_message FROM analytics.read_model_refreshes WHERE company_id = :c AND read_model = :m AND "trigger" = :trigger ORDER BY started_at, created_at`,
  { replacements: { c: env.cX.companyId, m: model, trigger } }
))[0];

test('DI-BI-4 os read models de IA são da empresa inteira e as passadas agendadas contam 1 agregado', async () => {
  for (const model of Object.keys(AI_MODELS)) {
    assert.deepEqual(readModels.getReadModel(model).aggregateColumns, [], `${model} não tem coluna de agregado: um só agregado por empresa`);
    const scheduled = await refreshesOf(model, 'SCHEDULE');
    assert.deepEqual(scheduled.map((r) => r.rows_upserted), [1, 1], `${model}: duas passadas agendadas, 1 linha cada`);
  }
});

test('DI-BI-4 rajada de 3 execuções da NAY no mesmo lote do outbox: rows_upserted = 1 e a checagem de contagem passa', async () => {
  await kit.inTx(env.cX, { commit: true }, async (tx) => {
    for (const runId of runs) {
      await publishAiEvent(env.cX, 'ai.run.completed', {
        runId, agentCode: 'NAY_DIRETORIA', agentVersion: 1, provider: 'ai-sandbox', model: 'm-small', routingPath: 'SMALL_MODEL', costAmount: '0.750000', groundingStatus: 'INSUFFICIENT_SOURCES', latencyMs: 10,
      }, tx);
    }
  });
  const result = await dispatchPendingEventsForCompany({ id: env.cX.groupId }, { id: env.cX.companyId }, { limit: 1000 });
  assert.ok(result.dispatched >= 3, 'as 3 execuções saíram no mesmo despacho');
  for (const [model, checkCode] of Object.entries(AI_MODELS)) {
    const [[applied]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.rm_applied_events WHERE company_id = :c AND read_model = :m AND source_event_id IN (SELECT id::text FROM integration.outbox_events WHERE company_id = :c AND event_type = \'ai.run.completed\')',
      { replacements: { c: env.cX.companyId, m: model } });
    assert.equal(applied.n, 3, `${model}: os 3 eventos foram aplicados`);
    const events = await refreshesOf(model, 'EVENT');
    assert.equal(events.length, 1, `${model}: o lote grava uma única linha de refresh`);
    const [batch] = events;
    assert.equal(batch.rows_upserted, 1, `${model}: o lote conta 1 agregado (a empresa), não 1 por evento`);
    const [[check]] = await env.admin.query('SELECT status, expected, observed FROM analytics.data_quality_checks WHERE refresh_id = :r AND check_code = :code', { replacements: { r: batch.id, code: checkCode } });
    assert.ok(check, `${model}: a checagem de contagem rodou no fim do lote`);
    assert.deepEqual([check.status, check.observed.rows, check.expected.average, check.expected.min, check.expected.max], ['PASSED', 1, 1, 1, 1], `${model}: 1 linha dentro da faixa [1, 1] da média 1`);
    assert.ok(!String(batch.error_message || '').includes(checkCode), `${model}: o refresh do lote não foi rebaixado pela contagem`);
  }
});
