'use strict';

// BRIEF-02 / DI-BI-8 (M9-D693 3.7, livro §17 e Guia §9) — o briefing que FALHOU é tentado de novo depois de `analytics.brief.reintento_falha_min` (aqui 1 minuto; o padrão de
// 60 está em m9d693.job) e a versão FAILED vira SUPERSEDED. O job roda de verdade (commit), com o relógio do BI fixo e sem acertar a hora da falha por fora: DI-BI-8 grava o
// generated_at no relógio do BI, o mesmo com que a nova tentativa mede o intervalo. Banco descartável (127.0.0.1); o que grava é removido no fim.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const e = require('../_helpers/m9d693Env');
const { purgeBriefResidue } = require('../_helpers/m9d693Purge');
const { runAnalyticsBriefJob } = require('../../../src/engines/jobs/analyticsBriefJob');
const briefs = require('../../../src/features/analytics/briefs');

let env;
before(async () => {
  env = await e.setup();
  await e.inTx(env.tenantA, { commit: true }, async (tx) => {
    const m = await e.metric(env, env.tenantA, tx, { current: '150', previous: '100', extraDays: [['2026-10-28', '300']] }); // registro de 27/10 e de 28/10 (os dois diários)
    await e.panel(env.tenantA, tx, { metrics: [{ code: m.code }] });
    await e.setting(env.tenantA, tx, 'ia.habilitada', true);
    await e.setting(env.tenantA, tx, 'ai.agents.enabled', '*');
    await e.setting(env.tenantA, tx, 'analytics.brief.reintento_falha_min', 1);
  });
});
after(async () => {
  await purgeBriefResidue(env);
  await e.teardown(env);
});

const A = () => env.tenantA;
const at = (iso) => { e.clock.setClock(() => new Date(iso)); return new Date(iso); };
const rows = async () => (await env.admin.query(
  `SELECT status, period_start::text AS "periodStart", blocked_reason AS reason, generated_at AS "generatedAt", jsonb_array_length(content->'itens') AS itens
     FROM analytics.executive_briefs WHERE company_id = :c AND brief_type = 'DAILY' ORDER BY created_at`, { replacements: { c: A().companyId } }
))[0];
const read = () => e.inTx(A(), {}, (tx) => briefs.getBriefForReader(e.readerOf(A(), ['analytics:brief:read', 'finance:read']), { briefType: 'DAILY' }, tx));
const run = (iso, agent) => runAnalyticsBriefJob({ now: at(iso), runAgent: agent, types: ['DAILY'] });

test('BRIEF-02 com analytics.brief.reintento_falha_min = 1, a falha é tentada de novo 1 minuto depois e o FAILED vira SUPERSEDED', async () => {
  const caido = e.agent(() => ({ ok: false, error: { status: 503, code: 'AI_SERVICE_IDENTITY_DISABLED', message: 'x' } }));
  const failed = await run('2026-10-28T09:41:00.000Z', caido);
  assert.equal(failed.failed, 1, JSON.stringify(failed));
  let r = await rows();
  assert.deepEqual(r.map((x) => [x.status, x.periodStart, x.itens]), [['FAILED', '2026-10-27', 0]], 'falha sem texto');
  assert.equal(new Date(r[0].generatedAt).toISOString(), '2026-10-28T09:41:00.000Z', 'DI-BI-8: a hora da falha é a do relógio do BI');
  const unavailable = await read();
  assert.deepEqual([unavailable.status, unavailable.available, unavailable.message, unavailable.items], ['FAILED', false, 'Briefing indisponível', []]);

  const corrigido = e.agent();
  await run('2026-10-28T09:41:59.999Z', corrigido);
  assert.equal(corrigido.calls.length, 0, '59,999 s depois da falha: ainda não tenta');
  assert.deepEqual((await rows()).map((x) => x.status), ['FAILED']);

  const retried = await run('2026-10-28T09:42:00.000Z', corrigido);
  assert.equal(retried.generated, 1, JSON.stringify(retried));
  assert.equal(corrigido.calls.length, 1, 'exatamente 1 minuto depois: tenta de novo');
  r = await rows();
  assert.deepEqual(r.map((x) => [x.status, x.periodStart]), [['SUPERSEDED', '2026-10-27'], ['GENERATED', '2026-10-27']]);
  assert.ok(r[1].itens >= 1, 'o briefing gerado tem itens');
  const available = await read();
  assert.deepEqual([available.status, available.available], ['GENERATED', true]);
  assert.ok(available.items.length >= 1 && available.items.every((i) => Array.isArray(i.fonte) && i.fonte.length >= 1), 'cada item com a sua fonte');

  await run('2026-10-28T09:50:00.000Z', corrigido);
  assert.equal(corrigido.calls.length, 1, 'briefing gerado não é refeito');
});

test('BRIEF-02 o mesmo intervalo de 1 minuto com o padrão (sem o parâmetro) não basta: 60 minutos', async () => {
  await env.admin.query("DELETE FROM core.tenant_settings WHERE company_id = :c AND key = 'analytics.brief.reintento_falha_min'", { replacements: { c: A().companyId } });
  const caido = e.agent(() => ({ ok: false, error: { status: 503, code: 'AI_SERVICE_IDENTITY_DISABLED', message: 'x' } }));
  assert.equal((await run('2026-10-29T09:41:00.000Z', caido)).failed, 1);
  const corrigido = e.agent();
  await run('2026-10-29T09:42:00.000Z', corrigido);
  await run('2026-10-29T10:40:59.999Z', corrigido);
  assert.equal(corrigido.calls.length, 0, 'padrão de 60: nem 1 minuto nem 59 min 59,999 s bastam');
  assert.equal((await run('2026-10-29T10:41:00.000Z', corrigido)).generated, 1);
  assert.deepEqual((await rows()).filter((x) => x.periodStart === '2026-10-28').map((x) => x.status), ['SUPERSEDED', 'GENERATED']);
});
