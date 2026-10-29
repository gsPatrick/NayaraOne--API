'use strict';

// M9-D690 — o detalhe paginado: todas as linhas do filtro, reconciliação com o KPI, mascaramento de RESTRICTED, log de acesso e limites.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env690 = require('../_helpers/m9d690Env');
const registry = require('../../../src/features/analytics/metrics');
const money = require('../../../src/features/analytics/metrics/formulas/money');

let env;
before(async () => { env = await env690.setup(); });
after(() => env690.teardown(env));

const m = (key) => env.metrics.find((x) => x.key === key);
async function allPages(metric, ref, pageSize) {
  const out = [];
  let page = 1;
  let body;
  do {
    const res = await env690.get(env, metric, ref, { extra: { page: String(page), pageSize: String(pageSize) } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    body = res.body.data;
    out.push(...body.rows);
    page += 1;
  } while (page <= body.totalPages);
  return { rows: out, last: body };
}

test('m9d690 soma do detalhe iguala o KPI', async () => {
  // SUM: as páginas juntas devolvem todas as linhas do filterHash e a soma das contribuições é o valor do KPI (M9-D611)
  const fin = m('fin');
  const ref = await env690.refOf(env, fin);
  const { rows, last } = await allPages(fin, ref, 2);
  assert.equal(rows.length, env690.INSIDE.length);
  assert.equal(last.totalPages, 3);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'nenhuma linha repetida entre páginas');
  const kpi = env690.sumSigned(env690.INSIDE).toFixed(2);
  assert.equal(money.money(money.sum(rows.map((r) => r.contribution))), kpi);
  assert.equal(last.aggregate.total, kpi);
  assert.equal(last.aggregate.count, env690.INSIDE.length);
  assert.equal(last.reconcileMode, 'SUM');
  const ctx = env.tenantA;
  const rec = await env690.inTx(ctx, {}, (tx) => registry.reconcileDetail(env690.ctxOf(ctx, []), fin.code, ref, kpi, { unit: 'BRL' }, tx));
  assert.equal(rec.ok, true, 'a mesma soma que o reconciliador de M9-D611 confere');
  // COUNT: o número de linhas é o valor
  const legal = m('legal');
  const legalAll = await allPages(legal, await env690.refOf(env, legal), 3);
  assert.equal(legalAll.rows.length, env690.INSIDE.length);
  assert.equal(legalAll.last.reconcileMode, 'COUNT');
  assert.ok(legalAll.rows.every((r) => r.contribution === '1'));
  // RECOMPUTE: as linhas alimentam a fórmula; a contribuição individual é nula
  const rent = m('rent');
  const rentAll = await allPages(rent, await env690.refOf(env, rent), 4);
  assert.equal(rentAll.rows.length, env690.INSIDE.length);
  assert.equal(rentAll.last.reconcileMode, 'RECOMPUTE');
  assert.ok(rentAll.rows.every((r) => r.contribution === null));
  // cada linha traz id, campos de negócio, link da tela e contribuição; o período e a empresa do filtro valem (ruído fica de fora)
  assert.match(rows[0].link, /^\/painel\/teste\/fin\/[0-9a-f-]{36}$/);
  assert.ok(rows.every((r) => 'cpf_titular' in r.fields && 'amount' in r.fields && 'status' in r.fields));
  assert.ok(rows.every((r) => r.fields.status === 'OK'));
});

test('m9d690 dados RESTRICTED vêm mascarados no detalhe', async () => {
  const legal = m('legal');
  const res = await env690.get(env, legal, await env690.refOf(env, legal), { extra: { pageSize: '10' } });
  assert.equal(res.status, 200);
  const text = JSON.stringify(res.body);
  for (const raw of ['529.982.247-25', '52998224725', '111.444.777-35', 'Maria da Silva Souza', 'José de Souza Lima']) assert.ok(!text.includes(raw), `não deve vazar ${raw}`);
  const first = res.body.data.rows.find((r) => r.fields.cpf_titular);
  assert.match(first.fields.cpf_titular, /^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
  assert.match(first.fields.nome_parte, /^([A-Z]\.\s?)+$/, 'parte de processo em iniciais');
  assert.ok(res.body.data.maskedCount >= 2 * env690.INSIDE.length);
});

test('m9d690 todo acesso ao detalhe gera log', async () => {
  const legal = m('legal');
  const ref = await env690.refOf(env, legal);
  const before = (await env690.accessLog(env, legal.code)).length;
  const ok = await env690.get(env, legal, ref, { extra: { pageSize: '3' } });
  assert.equal(ok.status, 200);
  const denied = await env690.get(env, legal, ref, { perms: ['analytics:read', 'analytics:drilldown'] });
  assert.equal(denied.status, 403);
  const log = await env690.accessLog(env, legal.code);
  assert.equal(log.length - before, 2, 'o acesso concedido e a tentativa negada ficam no log');
  const [granted, refused] = log.slice(before);
  assert.equal(granted.action, 'DRILLDOWN');
  assert.equal(granted.rows_returned, 3, 'quantidade de linhas devolvidas');
  assert.equal(granted.masking_applied, true, 'mascaramento aplicado');
  assert.equal(granted.company_id, env.tenantA.companyId);
  assert.equal(granted.user_id, env.tenantA.userId);
  assert.equal(granted.filters.filterHash, ref.filterHash);
  assert.equal(granted.filters.page, 1);
  assert.equal(refused.rows_returned, 0);
  assert.equal(refused.filters.denied, true);
  assert.ok(!JSON.stringify(log).includes('Maria'), 'o log não guarda dado de linha');
});

test('m9d690 limites de página, indicador sem detalhe e métrica inexistente', async () => {
  const legal = m('legal');
  const ref = await env690.refOf(env, legal);
  const tooBig = await env690.get(env, legal, ref, { extra: { pageSize: '201' } });
  assert.equal(tooBig.status, 400);
  assert.equal(tooBig.body.error.code, 'ANALYTICS_PAGE_SIZE_INVALID');
  assert.equal(tooBig.body.error.message, 'Tamanho de página inválido (máximo 200).');
  assert.equal((await env690.get(env, legal, ref, { extra: { pageSize: '200' } })).status, 200);
  assert.equal((await env690.get(env, legal, ref, { extra: { pageSize: '0' } })).body.error.code, 'ANALYTICS_PAGE_SIZE_INVALID');
  assert.equal((await env690.get(env, legal, ref, { extra: { pageSize: 'abc' } })).body.error.code, 'ANALYTICS_PAGE_SIZE_INVALID');
  assert.equal((await env690.get(env, legal, ref, { extra: { page: '0' } })).body.error.code, 'ANALYTICS_PAGE_INVALID');
  const beyond = await env690.get(env, legal, ref, { extra: { page: '9', pageSize: '2' } });
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.body.data.rows, [], 'página além do fim devolve lista vazia');
  const normal = m('prop');
  const normalRes = await env690.get(env, normal, await env690.refOf(env, normal));
  assert.equal(normalRes.status, 409);
  assert.equal(normalRes.body.error.code, 'ANALYTICS_DRILLDOWN_NOT_AVAILABLE');
  assert.equal(normalRes.body.error.message, 'Este indicador não oferece detalhe.');
  const ghost = await env.call('GET', `/analytics/metrics/x.nao_existe/drilldown?${env690.query(ref)}`, { perms: env690.ADMIN_PERMS(legal) });
  assert.equal(ghost.status, 404);
  assert.equal(ghost.body.error.code, 'ANALYTICS_METRIC_NOT_FOUND');
});

test('m9d690 o administrador muda o tamanho máximo e o padrão da página', async () => {
  const { upsertSetting, SETTINGS_SCHEMA } = require('../../../src/features/settings/settings.service');
  const { openDrilldown } = require('../../../src/features/analytics/metrics/drilldown.service');
  assert.ok(SETTINGS_SCHEMA['analytics.drilldown.tamanho_pagina_maximo'] && SETTINGS_SCHEMA['analytics.drilldown.tamanho_pagina_padrao'], 'declarados no SETTINGS_SCHEMA');
  const legal = m('legal');
  const ref = await env690.refOf(env, legal);
  const t = env.tenantA;
  const input = (extra = {}) => ({ metricCode: legal.code, filter: ref.filter, filterHash: ref.filterHash, filterSignature: ref.filterSignature, route: 'teste', ...extra });
  await env690.inTx(t, {}, async (tx) => {
    const ctx = env690.ctxOf(t, env690.ADMIN_PERMS(legal));
    await upsertSetting('analytics.drilldown.tamanho_pagina_maximo', 4, t, t.userId, tx);
    await upsertSetting('analytics.drilldown.tamanho_pagina_padrao', 3, t, t.userId, tx);
    const std = await openDrilldown(ctx, input(), tx);
    assert.equal(std.pageSize, 3, 'padrão do administrador');
    assert.equal(std.rows.length, 3);
    await assert.rejects(openDrilldown(ctx, input({ pageSize: '5' }), tx), (e) => e.statusCode === 400 && e.message === 'Tamanho de página inválido (máximo 4).');
    await upsertSetting('analytics.drilldown.tamanho_pagina_padrao', 9, t, t.userId, tx);
    assert.equal((await openDrilldown(ctx, input(), tx)).pageSize, 4, 'o padrão nunca passa do máximo');
    await assert.rejects(upsertSetting('analytics.drilldown.tamanho_pagina_maximo', 1001, t, t.userId, tx), (e) => e.statusCode === 400);
  });
});
