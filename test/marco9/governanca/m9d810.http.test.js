'use strict';

// M9-D810 — POST|PUT /data-lineage/nodes e /edges e GET /data-lineage pela API real (banco descartável): permissão, erros do livro e isolamento.
process.env.PORT = process.env.M9D810_HTTP_TEST_PORT || '21660';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');
const env = require('../_helpers/m9d810Env');

let http;
before(async () => {
  // a permissão entra no token no login: concede antes de entrar
  if (env.DISPOSABLE) { await env.setLineagePermission('CI GESTOR', true); await env.setLineagePermission('CI LEITURA', false); }
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], leituraA: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
});
after(async () => { if (!http.skip) { await env.setLineagePermission('CI GESTOR', false); } await stopHttp({}); });

const node = (over = {}) => ({ node_type: 'SOURCE_FIELD', code: `qa.http.${Date.now()}`, description: 'QA-M9 origem', owner_domain: 'FINANCEIRO', area: 'MONEY', ...over });

test('m9d810 sem a permissão governance:lineage:manage devolve 403 em todas as rotas', async (t) => {
  if (http.skip) return t.skip(http.skip);
  for (const [method, path, body] of [['GET', '/data-lineage'], ['POST', '/data-lineage/nodes', node()], ['PUT', '/data-lineage/nodes', node()], ['POST', '/data-lineage/edges', {}], ['PUT', '/data-lineage/edges', {}]]) {
    const res = await http.call('leituraA', method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error.code, 'PERMISSION_DENIED');
    assert.equal(res.body.error.details.required, 'governance:lineage:manage');
  }
});

test('m9d810 nó sem owner_domain devolve 422 GOV_LINEAGE_OWNER_REQUIRED pela rota', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const res = await http.call('gestorA', 'PUT', '/data-lineage/nodes', node({ owner_domain: undefined }));
  assert.equal(res.status, 422);
  assert.deepEqual([res.body.error.code, res.body.error.message], ['GOV_LINEAGE_OWNER_REQUIRED', 'Informe o domínio responsável pelo nó.']);
  assert.ok(res.body.error.traceId);
});

test('m9d810 registra um KPI com as cinco camadas pela rota e recusa a aresta inválida', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const code = `qa.http.kpi.${Date.now()}`;
  const layers = ['SOURCE_FIELD', 'DOMAIN_FIELD', 'EVENT', 'READ_MODEL', 'METRIC'];
  for (const layer of layers) {
    const res = await http.call('gestorA', 'PUT', '/data-lineage/nodes', node({ node_type: layer, code: layer === 'METRIC' ? code : `${code}.${layer}`, area: 'EXEC_KPI' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.criticality, 'CRITICAL');
  }
  const ref = (i) => ({ node_type: layers[i], code: layers[i] === 'METRIC' ? code : `${code}.${layers[i]}` });
  for (let i = 0; i < 4; i += 1) {
    const res = await http.call('gestorA', 'PUT', '/data-lineage/edges', { from_node: ref(i), to_node: ref(i + 1), transformation: 'soma' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  const bad = await http.call('gestorA', 'PUT', '/data-lineage/edges', { from_node: ref(0), to_node: ref(4), transformation: 'pula' });
  assert.deepEqual([bad.status, bad.body.error.code, bad.body.error.message], [422, 'GOV_LINEAGE_LAYER_INVALID', 'Esta ligação não respeita a ordem das camadas.']);
  const back = await http.call('gestorA', 'PUT', '/data-lineage/edges', { from_node: ref(3), to_node: ref(1), transformation: 'volta' });
  assert.equal(back.body.error.code, 'GOV_LINEAGE_LAYER_INVALID');
  const ghost = await http.call('gestorA', 'PUT', '/data-lineage/edges', { from_node: ref(0), to_node: { node_type: 'DOMAIN_FIELD', code: 'nao.existe' }, transformation: 'x' });
  assert.deepEqual([ghost.status, ghost.body.error.code, ghost.body.error.message], [404, 'GOV_NOT_FOUND', 'Nó de lineage não encontrado.']);
});

test('m9d810 rebaixar a criticidade de área obrigatória devolve 409 e POST repetido 409', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const body = node({ code: `qa.http.trava.${Date.now()}`, criticality: 'NORMAL' });
  const locked = await http.call('gestorA', 'POST', '/data-lineage/nodes', body);
  assert.deepEqual([locked.status, locked.body.error.code, locked.body.error.message], [409, 'GOV_LINEAGE_CRITICALITY_LOCKED', 'Esta área exige lineage crítico.']);
  const ok = { ...body, criticality: 'CRITICAL' };
  assert.equal((await http.call('gestorA', 'POST', '/data-lineage/nodes', ok)).status, 201);
  assert.equal((await http.call('gestorA', 'POST', '/data-lineage/nodes', ok)).body.error.code, 'GOV_LINEAGE_NODE_EXISTS');
  const invalid = await http.call('gestorA', 'PUT', '/data-lineage/nodes', node({ node_type: 'COLUNA' }));
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, 'GOV_LINEAGE_NODE_TYPE_INVALID']);
});

test('m9d810 GET /data-lineage devolve a cobertura do grupo e a outra empresa não vê nó de outro grupo', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const code = `qa.http.iso.${Date.now()}`;
  assert.equal((await http.call('gestorA', 'PUT', '/data-lineage/nodes', node({ code }))).status, 200);
  const a = await http.call('gestorA', 'GET', '/data-lineage');
  assert.equal(a.status, 200);
  assert.equal(a.body.data.cobertura.percent, 100);
  assert.equal(a.body.data.itens.nos >= 1, true);
  const [{ n }] = (await env.adminQuery('SELECT count(*)::int AS n FROM governance.lineage_nodes WHERE code = $1', [code])).rows;
  assert.equal(n, 1);
  const b = await http.call('gestorB', 'GET', '/data-lineage');
  assert.equal(b.status, 200);
  const { rows } = await env.adminQuery('SELECT group_id FROM governance.lineage_nodes WHERE code = $1', [code]);
  assert.equal(rows[0].group_id, http.tenants.A.groupId);
});
