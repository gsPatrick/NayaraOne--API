'use strict';

// M9-D696 (reabertura) — o catálogo mínimo do livro em TODOS os read models de domínio (Comercial, Imóveis, Locação, Obras, Estoque, Jurídico,
// Correspondente, Marketing, Atendimento): roda sem erro, a conciliação recalcula da fonte e pega divergência, a invariante e a completude
// reprovam, e o limite de chaves é parâmetro. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bi = require('../_helpers/biEnv');
const quality = require('../../../src/features/analytics/quality');
const clock = require('../../../src/features/analytics/metrics/clock');
const readModels = require('../../../src/features/analytics/read-models');

const { src, apply, makeEvent, setSetting } = bi;
const MODEL = 'rm_crm_lead_daily';
const DOMAIN_MODELS = () => readModels.listReadModels().map((d) => d.name).filter((n) => !/^rm_finance_/.test(n));
let env;
const scopeOf = (t) => ({ companyId: t.companyId, groupId: t.groupId });
const run = (tenant, model = MODEL) => bi.inTx(tenant, { commit: true }, (tx) => quality.executeChecks({ readModel: model, scope: scopeOf(tenant), mode: 'EVENT' }, tx));
const by = (results, code) => results.find((r) => r.checkCode === code);

before(async () => {
  env = await bi.setup();
  clock.setClock(() => new Date(bi.NOW.getTime() + 60000));
});
after(async () => {
  clock.resetClock();
  await bi.teardown(env);
});

test('m9d696 todo read model de domínio declara o catálogo e ele roda sem erro numa empresa vazia', async () => {
  const names = DOMAIN_MODELS();
  assert.ok(names.length >= 40, `esperava os read models de domínio, vieram ${names.length}`);
  const problems = [];
  for (const model of names) {
    const results = await run(env.cY, model);
    const types = new Set(results.map((r) => r.checkType));
    for (const t of ['FRESHNESS', 'RECONCILIATION', 'INVARIANT', 'COMPLETENESS', 'DUPLICATION', 'ROW_COUNT_RANGE']) if (!types.has(t)) problems.push(`${model}: falta ${t}`);
    for (const r of results.filter((x) => x.status !== 'PASSED')) problems.push(`${model}/${r.checkCode}: ${r.status} ${JSON.stringify(r.observed).slice(0, 220)}`);
  }
  assert.deepEqual(problems, [], 'empresa vazia: o catálogo de cada read model roda e passa');
});

test('m9d696 conciliação recalcula da fonte e detecta divergência (evento perdido) e a corrige no refresh seguinte', async () => {
  const t = env.cX;
  const base = '2026-10-20T15:00:00Z';
  const o1 = await src.opportunity(env, t, { owner: src.uuid(), source: 'PORTAL_A', created: base });
  await apply(t, makeEvent(t, 'crm.opportunity.created', { id: o1 }));
  const good = await run(t);
  assert.equal(by(good, 'crm_lead_daily_reconciliation').status, 'PASSED', JSON.stringify(by(good, 'crm_lead_daily_reconciliation').observed));
  assert.equal(by(good, 'crm_lead_daily_reconciliation').expected.columns.leads.value, '1');

  await src.opportunity(env, t, { owner: src.uuid(), source: 'PORTAL_A', created: base }); // entra na fonte sem evento: o read model perde esta
  const bad = await run(t);
  const rec = by(bad, 'crm_lead_daily_reconciliation');
  assert.deepEqual([rec.status, rec.severity], ['FAILED', 'CRITICAL']);
  assert.deepEqual([rec.expected.columns.leads.value, rec.observed.columns.leads.value, rec.observed.columns.leads.difference], ['1', '2', '1']);
  assert.deepEqual(rec.observed.failedColumns, ['leads']);
  assert.ok(rec.affectedMetricCodes.includes('crm.leads_by_origin'));

  await apply(t, makeEvent(t, 'crm.opportunity.created', { id: o1 })); // o evento recalcula o dia inteiro
  assert.equal(by(await run(t), 'crm_lead_daily_reconciliation').status, 'PASSED');
});

test('m9d696 invariante e completude do read model de domínio reprovam e a completude obedece ao parâmetro', async () => {
  const t = env.cX;
  await env.admin.query('UPDATE analytics.rm_crm_lead_daily SET first_response_count = leads + 1 WHERE company_id = :c', { replacements: { c: t.companyId } });
  const inv = by(await run(t), 'crm_lead_daily_invariant');
  assert.deepEqual([inv.status, inv.severity], ['FAILED', 'CRITICAL']);
  assert.ok(inv.observed.rowsViolating >= 1);
  await env.admin.query('UPDATE analytics.rm_crm_lead_daily SET first_response_count = 0 WHERE company_id = :c', { replacements: { c: t.companyId } });

  await src.opportunity(env, t, { owner: src.uuid(), source: null, created: '2026-10-21T15:00:00Z' });
  const comp = by(await run(t), 'crm_lead_daily_lead_source_completeness');
  assert.equal(comp.status, 'FAILED');
  assert.ok(comp.observed.nulls >= 1 && comp.observed.pct > 0);
  await setSetting(env, t, 'analytics.qualidade.max_nulos_pct.lead_source', 100);
  assert.equal(by(await run(t), 'crm_lead_daily_lead_source_completeness').status, 'PASSED', 'o limite do campo é parâmetro do administrador');
});

test('m9d696 o limite de chaves da conciliação é parâmetro e refresh vazio com a fonte cheia reprova', async () => {
  const t = env.cX;
  await apply(t, makeEvent(t, 'crm.opportunity.created', { id: (await env.admin.query('SELECT id FROM crm.opportunities WHERE company_id = :c LIMIT 1', { replacements: { c: t.companyId } }))[0][0].id }));
  await setSetting(env, t, 'analytics.qualidade.max_chaves_conciliacao', 1);
  const rec = by(await run(t), 'crm_lead_daily_reconciliation');
  assert.equal(rec.expected.keys, 1, 'só a chave mais recente entra na conciliação');
  await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id = :c AND key = :k', { replacements: { c: t.companyId, k: 'analytics.qualidade.max_chaves_conciliacao' } });

  // Faixa de linhas: o refresh trouxe zero linhas e a fonte tem oportunidades.
  const zero = await bi.inTx(t, { commit: true }, (tx) => quality.executeChecks({ readModel: MODEL, scope: scopeOf(t), mode: 'EVENT', rowsUpserted: 0 }, tx));
  const range = by(zero, 'crm_lead_daily_row_count');
  assert.deepEqual([range.status, range.severity, range.observed.sourcePopulated], ['FAILED', 'CRITICAL', true]);
});
