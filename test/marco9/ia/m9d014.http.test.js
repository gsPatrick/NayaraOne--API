'use strict';

// M9-D014 — rotas GET/POST /v1/ai/budgets e PUT /v1/ai/budgets/:id por HTTP real: permissões, 400, auditoria e isolamento entre empresas.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');

let env;
before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:budget', 'ai:audit', 'ai:use', 'ai:read', 'settings:read', 'settings:update', 'ai:admin']);
  await grant('CI LEITURA', ['ai:audit']);
  await grant('CI SOMENTE', ['ai:use']);
  env = await startHttpEnv(Number(process.env.M9D014_HTTP_TEST_PORT) || 21714, [['A', 'gestor'], ['A', 'leitura'], ['B', 'gestor']]);
});
after(async () => {
  if (!env) return;
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: false });
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['B:gestor'], { value: false });
  setTimeout(() => process.exit(0), 300);
});

test('m9d014_http_orcamento_leitura_escrita_permissoes_e_isolamento', { skip: SKIP }, async () => {
  const { call, tokens } = env;
  assert.equal((await call('GET', '/ai/budgets', tokens['A:gestor'])).body.error.code, 'AI_FEATURE_DISABLED');
  for (const t of ['A:gestor', 'B:gestor']) assert.equal((await call('PUT', '/settings/ia.habilitada', tokens[t], { value: true })).status, 200);
  assert.equal((await call('GET', '/ai/budgets')).status, 401);

  const criado = await call('POST', '/ai/budgets', tokens['A:gestor'], { agentCode: 'NAY_FINANCEIRA', limitAmount: '500.00' });
  assert.equal(criado.status, 201, JSON.stringify(criado.body));
  const id = criado.body.data.id;
  assert.equal((await call('POST', '/ai/budgets', tokens['A:gestor'], { agentCode: 'NAY_FINANCEIRA', limitAmount: '10.00' })).body.error.code, 'AI_BUDGET_EXISTS');
  assert.equal((await call('POST', '/ai/budgets', tokens['A:leitura'], { limitAmount: '10.00' })).status, 403);

  // Lê quem tem ai:audit (sem editar); edita só ai:budget.
  const lista = await call('GET', '/ai/budgets', tokens['A:leitura']);
  assert.equal(lista.status, 200);
  const item = lista.body.data.find((b) => b.id === id);
  assert.equal(item.consumedAmount, '0.000000');
  assert.equal(item.consumedPct, '0.00');
  assert.deepEqual(item.effectiveThresholds, [50, 75, 90, 100]);
  assert.equal((await call('PUT', `/ai/budgets/${id}`, tokens['A:leitura'], { limitAmount: '600.00' })).status, 403);

  const editado = await call('PUT', `/ai/budgets/${id}`, tokens['A:gestor'], { limitAmount: '600.00', actionAt100: 'DEGRADE' });
  assert.equal(editado.status, 200, JSON.stringify(editado.body));
  assert.equal(editado.body.data.limitAmount, '600.00');
  assert.equal((await call('PUT', `/ai/budgets/${id}`, tokens['A:gestor'], { limitAmount: '-1' })).body.error.code, 'AI_BUDGET_INVALID');
  assert.equal((await call('PUT', `/ai/budgets/${id}`, tokens['A:gestor'], { status: 'PAUSED' })).body.data.status, 'PAUSED');

  // Empresa B não enxerga nem altera a linha da empresa A: 404 sem revelar existência.
  assert.ok(!(await call('GET', '/ai/budgets', tokens['B:gestor'])).body.data.some((b) => b.id === id));
  const alheio = await call('PUT', `/ai/budgets/${id}`, tokens['B:gestor'], { limitAmount: '1.00' });
  assert.equal(alheio.status, 404);
  assert.equal(alheio.body.error.code, 'AI_BUDGET_NOT_FOUND');
});
