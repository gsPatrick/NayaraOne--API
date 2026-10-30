'use strict';

// M9-D863 — GET /finops/health e GET|PUT /finops/degradation-policies pela API real: permissão, recusas do livro e isolamento entre grupos (banco descartável).

process.env.PORT = process.env.M9D863_HTTP_TEST_PORT || '21863';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d861Http');

before(async () => { await http.start(); });
// Os orçamentos criados aqui são do domínio FISCAL (os outros testes usam PLATFORM) e saem no fim: nada fica no banco compartilhado da suíte.
after(async () => {
  if (!http.state.skip) await http.adminQuery("DELETE FROM governance.budgets WHERE domain = 'FISCAL' AND environment IN ('DEV', 'HOMOLOG')");
  await http.stop();
});
const skipReason = () => http.state.skip;

test('m9d863 política de degradação pela API, com permissão de gestão e os erros do livro', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const budget = await http.call('A:gestor', 'POST', '/finops/budgets', { environment: 'DEV', domain: 'FISCAL', amountCents: 100000, ownerUserId: A.userId });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  const body = { budgetId: budget.body.data.id, steps: [{ step: 'SWITCH_AI_MODEL_CHEAPER' }, { step: 'LIMIT_EXPORT_SIZE' }] };
  assert.equal((await http.call(null, 'PUT', '/finops/degradation-policies', body)).status, 401);
  const denied = await http.call('A:leitura', 'PUT', '/finops/degradation-policies', body);
  assert.deepEqual([denied.status, denied.body.error.code], [403, 'PERMISSION_DENIED']);
  const crit = await http.call('A:gestor', 'PUT', '/finops/degradation-policies', { ...body, steps: [{ step: 'DISABLE_LOGIN' }] });
  assert.deepEqual([crit.status, crit.body.error.code, crit.body.error.message], [422, 'GOV_FINOPS_CRITICAL_NOT_DEGRADABLE', 'Esta função é crítica e não pode ser degradada.']);
  const prod = await http.call('A:gestor', 'PUT', '/finops/degradation-policies', { ...body, steps: [{ step: 'SHUTDOWN_PROD' }] });
  assert.deepEqual([prod.status, prod.body.error.code, prod.body.error.message], [403, 'GOV_FINOPS_PROD_PROTECTED', 'O ambiente de produção não pode ser desligado por custo.']);
  const saved = await http.call('A:gestor', 'PUT', '/finops/degradation-policies', body);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.data.steps, [{ step: 'SWITCH_AI_MODEL_CHEAPER', threshold: 90 }, { step: 'LIMIT_EXPORT_SIZE', threshold: 100 }]);
  const list = await http.call('A:gestor', 'GET', '/finops/degradation-policies');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.politicas.some((p) => p.id === saved.body.data.id));
  assert.equal(list.body.data.passosAceitos.length, 5);
  assert.equal((await http.call('A:leitura', 'GET', '/finops/degradation-policies')).status, 403);
});

test('m9d863 GET /finops/health respeita RLS: o grupo B não vê orçamento, política nem degradação do A', async (t) => {
  if (skipReason()) return t.skip(skipReason());
  const { A } = http.state.tenants;
  const budget = await http.call('A:gestor', 'POST', '/finops/budgets', { environment: 'HOMOLOG', domain: 'FISCAL', amountCents: 100000, ownerUserId: A.userId });
  assert.equal(budget.status, 201, JSON.stringify(budget.body));
  await http.call('A:gestor', 'PUT', '/finops/degradation-policies', { budgetId: budget.body.data.id, steps: [{ step: 'REDUCE_LOG_LEVEL' }] });
  const mineA = await http.call('A:gestor', 'GET', '/finops/health');
  assert.equal(mineA.status, 200);
  assert.ok(['OK', 'ATTENTION', 'CRITICAL'].includes(mineA.body.data.status));
  assert.ok(mineA.body.data.ambientes.some((a) => a.dominios.some((d) => d.orcamentoId === budget.body.data.id)));
  const asB = await http.call('B:gestor', 'GET', '/finops/health');
  assert.equal(asB.status, 200);
  assert.ok(!JSON.stringify(asB.body.data).includes(budget.body.data.id), 'o health do B não traz nada do A');
  const listB = await http.call('B:gestor', 'GET', '/finops/degradation-policies');
  assert.deepEqual(listB.body.data.politicas, []);
  const putB = await http.call('B:gestor', 'PUT', '/finops/degradation-policies', { budgetId: budget.body.data.id, steps: [{ step: 'REDUCE_LOG_LEVEL' }] });
  assert.deepEqual([putB.status, putB.body.error.code], [404, 'GOV_BUDGET_NOT_FOUND']);
  assert.equal((await http.call('A:leitura', 'GET', '/finops/health')).status, 403);
});
