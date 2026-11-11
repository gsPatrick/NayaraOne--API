'use strict';

// DI-BI-6 — o job do briefing guardava "sem fontes" pela vida do processo: se nenhum indicador tinha registro na primeira tentativa do dia, o briefing daquele período nunca
// mais era tentado até o servidor reiniciar, mesmo depois de o registro aparecer. Agora a memória vale só por analytics.brief.reintento_falha_min. Banco descartável.
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
const rowsOf = async () => (await env.admin.query(
  "SELECT status, period_start::text AS \"periodStart\" FROM analytics.executive_briefs WHERE company_id = :c AND brief_type = 'DAILY' AND period_start = '2026-11-03' ORDER BY created_at",
  { replacements: { c: A().companyId } }
))[0];

test('m9bi briefing: "sem fontes" é tentado de novo depois de analytics.brief.reintento_falha_min, não só depois de reiniciar o servidor', async () => {
  await e.inTx(A(), { commit: true }, async (tx) => {
    await e.setting(A(), tx, 'ia.habilitada', true);
    await e.setting(A(), tx, 'ai.agents.enabled', '*');
    await e.setting(A(), tx, 'analytics.brief.reintento_falha_min', 30);
  });
  const agent = e.agent();
  // 06:31 de 04/11 em SP: nenhum indicador com registro de 03/11
  const first = await runAnalyticsBriefJob({ now: at('2026-11-04T09:31:00Z'), runAgent: agent, types: ['DAILY'] });
  assert.ok(first.noSources >= 1, JSON.stringify(first));
  assert.deepEqual(await rowsOf(), []);
  // o registro do dia aparece depois (snapshot atrasado, captura tardia)
  await e.inTx(A(), { commit: true }, async (tx) => {
    const m = await e.metric(env, A(), tx, { current: '150', previous: '100', days: { previous: '2026-11-02', current: '2026-11-03' } });
    await e.panel(A(), tx, { metrics: [{ code: m.code }] });
  });
  const early = await runAnalyticsBriefJob({ now: at('2026-11-04T09:40:00Z'), runAgent: agent, types: ['DAILY'] });
  assert.ok(early.noSources >= 1, '9 minutos depois: ainda dentro do intervalo de nova tentativa');
  assert.equal(agent.calls.length, 0);
  const retry = await runAnalyticsBriefJob({ now: at('2026-11-04T10:02:00Z'), runAgent: agent, types: ['DAILY'] });
  assert.equal(retry.generated, 1, JSON.stringify(retry));
  assert.deepEqual((await rowsOf()).map((r) => r.status), ['GENERATED']);
  assert.equal(agent.calls.length, 1);
});
