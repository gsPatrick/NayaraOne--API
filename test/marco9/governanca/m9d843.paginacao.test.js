'use strict';

// M9-D843 §3.2 — toda lista de governança devolve o bloco único `pagination {page,pageSize,total,totalPages}` e recusa pageSize acima de 200 (API real, banco descartável).
process.env.PORT = process.env.M9D843_PAGINACAO_TEST_PORT || '21847';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d843Env');

let http;
let restore;
const skip = () => (http && http.skip) || (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
const PERMISSIONS = {
  'governance:bcp:record': true, 'governance:bcp:import': true, 'governance:bcp:approve': true, 'governance:data-quality:read': true, 'governance:data-quality:bulk': true,
  'governance:dlp:admin': true, 'governance:calendar:read': true,
};
/** As dez listas da governança (a rota, e se o `data` é lista ou objeto com `items`). */
const LISTS = [
  '/calendar', '/data-quality', '/data-quality/domains', '/data-quality/queue', '/data-quality/bulk-changes', '/bcp/manual-operations', '/bcp/reconciliations',
  '/bcp/form-templates', '/dlp/policies', '/dlp/anomalies', '/dlp/share-links',
];
const SHAPE = ['page', 'pageSize', 'total', 'totalPages'];

before(async () => {
  if (!env.DISPOSABLE) return;
  restore = await env.grantTracked('CI GESTOR', Object.keys(PERMISSIONS));
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], gestorB: ['B', 'gestor'] } });
  await env.cleanBcp();
  await env.setSectorRoles(http.tenants.A, { FINANCEIRO: ['CI GESTOR'] });
});
after(async () => { if (env.DISPOSABLE) { await env.cleanBcp(); await restore(); } await stopHttp({}); });

test('m9d843 toda lista de governança devolve pagination no formato único', { skip: skip() }, async () => {
  for (const route of LISTS) {
    const res = await http.call('gestorA', 'GET', `${route}?pageSize=2`);
    assert.equal(res.status, 200, `${route} ${JSON.stringify(res.body)}`);
    assert.deepEqual(Object.keys(res.body.pagination).sort(), [...SHAPE].sort(), `${route} traz o bloco com as quatro chaves`);
    assert.ok(SHAPE.every((key) => Number.isInteger(res.body.pagination[key])), `${route} só números inteiros`);
    assert.equal(res.body.pagination.page, 1);
    assert.equal(res.body.pagination.pageSize, 2, `${route} respeita o pageSize pedido`);
    assert.equal(res.body.pagination.totalPages, Math.ceil(res.body.pagination.total / 2));
    const rows = Array.isArray(res.body.data) ? res.body.data : res.body.data.items;
    assert.ok(Array.isArray(rows) && rows.length <= 2, `${route} nunca devolve mais que o pageSize`);
    assert.equal(res.body.traceId, undefined, 'nada de traceId na raiz');
  }
});

test('m9d843 toda lista recusa pageSize acima de 200 e paginação inválida, sem cortar em silêncio', { skip: skip() }, async () => {
  for (const route of LISTS) {
    for (const bad of ['pageSize=201', 'pageSize=500', 'pageSize=0', 'page=0', 'page=x']) {
      const res = await http.call('gestorA', 'GET', `${route}?${bad}`);
      assert.deepEqual([route, bad, res.status, res.body.error && res.body.error.code], [route, bad, 400, 'GOV_VALIDATION_PAGINATION']);
    }
    const max = await http.call('gestorA', 'GET', `${route}?pageSize=200`);
    assert.equal(max.status, 200, route);
    assert.equal(max.body.pagination.pageSize, 200);
  }
});

test('m9d843 sem pageSize vale o padrão e o total e as páginas batem com os registros', { skip: skip() }, async () => {
  const A = http.tenants.A;
  for (let i = 0; i < 3; i += 1) await env.record(A);
  const all = await http.call('gestorA', 'GET', '/bcp/manual-operations?pageSize=200');
  const total = all.body.pagination.total;
  assert.ok(total >= 3 && all.body.data.length === total);
  const p1 = await http.call('gestorA', 'GET', '/bcp/manual-operations?pageSize=2&page=1');
  const p2 = await http.call('gestorA', 'GET', '/bcp/manual-operations?pageSize=2&page=2');
  assert.deepEqual(p1.body.pagination, { page: 1, pageSize: 2, total, totalPages: Math.ceil(total / 2) });
  assert.equal(p2.body.pagination.page, 2);
  assert.deepEqual([...p1.body.data, ...p2.body.data].map((o) => o.id), all.body.data.slice(0, p1.body.data.length + p2.body.data.length).map((o) => o.id), 'as páginas seguem a mesma ordem, sem repetir nem pular');
  const past = await http.call('gestorA', 'GET', `/bcp/manual-operations?pageSize=2&page=${Math.ceil(total / 2) + 5}`);
  assert.deepEqual([past.status, past.body.data, past.body.pagination.total], [200, [], total], 'página além do fim: lista vazia e o total real');
  const dflt = await http.call('gestorA', 'GET', '/dlp/policies');
  assert.deepEqual([dflt.body.pagination.page, dflt.body.pagination.pageSize], [1, 50], 'padrão de governanca.api.paginacao.tamanho_padrao');
  const other = await http.call('gestorB', 'GET', '/bcp/manual-operations');
  assert.equal(other.body.pagination.total, 0, 'a empresa B não enxerga as operações da A');
});

test('m9d843 a fila de merge e as anomalias deixam de aceitar limit e offset próprios', { skip: skip() }, async () => {
  for (const route of ['/data-quality/queue', '/dlp/anomalies', '/bcp/manual-operations', '/bcp/reconciliations']) {
    const res = await http.call('gestorA', 'GET', `${route}?limit=1&offset=5`);
    assert.equal(res.status, 200, route);
    assert.equal(res.body.pagination.page, 1, `${route} ignora offset: a página é page/pageSize`);
    assert.notEqual(res.body.pagination.pageSize, 1, `${route} ignora limit: o tamanho é o padrão do parâmetro`);
  }
});
