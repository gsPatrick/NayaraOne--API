'use strict';

// M9-D693 (3.1, 3.7) — o job do briefing: só gera depois do horário, uma vez por período, só com a IA e o agente ligados na empresa, e a
// falha do provider vira FAILED sem texto. Roda de verdade (commit), em banco descartável; o que grava é removido no fim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d693Env');
const { purgeBriefResidue } = require('../_helpers/m9d693Purge');
const { runAnalyticsBriefJob } = require('../../../src/engines/jobs/analyticsBriefJob');

let env;
before(async () => { env = await e.setup(); });
after(async () => {
  await purgeBriefResidue(env);
  await e.teardown(env);
});

const A = () => env.tenantA;
const at = (iso) => { e.clock.setClock(() => new Date(iso)); return new Date(iso); };
const rowsOf = async (type = 'DAILY') => (await env.admin.query(
  'SELECT id, status, period_start::text AS "periodStart", blocked_reason AS "reason", ai_run_id FROM analytics.executive_briefs WHERE company_id = :c AND brief_type = :t ORDER BY created_at',
  { replacements: { c: A().companyId, t: type } }
))[0];

test('m9d693 o job gera às 06:30 SP, uma vez por período, só com a IA ligada, e a falha do provider vira FAILED', async () => {
  await e.inTx(A(), { commit: true }, async (tx) => {
    const m = await e.metric(env, A(), tx, { current: '150', previous: '100', extraDays: [['2026-10-28', '300']] });
    await e.panel(A(), tx, { metrics: [{ code: m.code }] });
  });
  const agent = e.agent();
  // antes das 06:30 SP: nada
  let out = await runAnalyticsBriefJob({ now: at('2026-10-28T09:29:00Z'), runAgent: agent, types: ['DAILY'] });
  assert.equal(out.generated, 0);
  assert.deepEqual(await rowsOf(), []);
  // 06:30 com a IA desligada (padrão do sistema): nada é gravado e a NAY nem é chamada
  out = await runAnalyticsBriefJob({ now: at('2026-10-28T09:30:00Z'), runAgent: agent, types: ['DAILY'] });
  assert.equal(out.generated, 0);
  assert.ok(out.aiOff >= 1);
  assert.deepEqual(await rowsOf(), []);
  assert.equal(agent.calls.length, 0);
  // IA e agente ligados: gera o do dia anterior
  await e.inTx(A(), { commit: true }, async (tx) => {
    await e.setting(A(), tx, 'ia.habilitada', true);
    await e.setting(A(), tx, 'ai.agents.enabled', '*');
  });
  out = await runAnalyticsBriefJob({ now: at('2026-10-28T09:41:00Z'), runAgent: agent, types: ['DAILY'] });
  assert.equal(out.generated, 1, JSON.stringify(out));
  let rows = await rowsOf();
  assert.deepEqual(rows.map((r) => [r.status, r.periodStart]), [['GENERATED', '2026-10-27']]);
  assert.ok(rows[0].ai_run_id);
  assert.equal(agent.calls.length, 1);
  // um minuto depois: o período já tem briefing, nada se refaz
  out = await runAnalyticsBriefJob({ now: at('2026-10-28T09:42:00Z'), runAgent: agent, types: ['DAILY'] });
  assert.equal(out.generated, 0);
  assert.ok(out.existing >= 1);
  assert.equal(agent.calls.length, 1);
  // no dia seguinte, outro período. O provider cai: FAILED com o código, sem texto, e o job não repete a tentativa a cada minuto
  const caido = e.agent(() => ({ ok: false, error: { status: 429, code: 'AI_BUDGET_EXHAUSTED', message: 'x' } }));
  out = await runAnalyticsBriefJob({ now: at('2026-10-29T09:41:00Z'), runAgent: caido, types: ['DAILY'] });
  assert.equal(out.failed, 1);
  await runAnalyticsBriefJob({ now: at('2026-10-29T09:42:00Z'), runAgent: caido, types: ['DAILY'] });
  assert.equal(caido.calls.length, 1);
  rows = await rowsOf();
  assert.deepEqual(rows.map((r) => [r.status, r.periodStart, r.reason]), [['GENERATED', '2026-10-27', null], ['FAILED', '2026-10-28', 'ANALYTICS_BRIEF_AI_BUDGET']]);
});

test('m9d693 o semanal sai na segunda às 07:00 SP', async () => {
  const agent = e.agent();
  const antes = await runAnalyticsBriefJob({ now: at('2026-11-02T09:59:00Z'), runAgent: agent, types: ['WEEKLY'] });
  assert.ok(antes.notDue > 0, 'segunda 06:59 em SP: ainda não é a hora');
  assert.equal(antes.generated + antes.failed + antes.blocked, 0);
  const depois = await runAnalyticsBriefJob({ now: at('2026-11-02T10:00:00Z'), runAgent: agent, types: ['WEEKLY'] });
  assert.equal(depois.notDue, 0, 'segunda 07:00 em SP: devido em todas as empresas');
  assert.equal(agent.calls.length, 0, 'sem registro da semana não há o que escrever nem texto inventado');
  assert.deepEqual(await rowsOf('WEEKLY'), []);
});
