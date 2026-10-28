'use strict';

// M9-D016 — GET /v1/ai/tools: só ai:admin lista, a chave geral vale, e a visão nunca traz `execute`.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');

let env;
before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  await grant('CI LEITURA', ['ai:use']);
  env = await startHttpEnv(Number(process.env.M9D016_HTTP_TEST_PORT) || 21716, [['A', 'gestor'], ['A', 'leitura']]);
});
after(async () => {
  if (!env) return;
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: false });
  setTimeout(() => process.exit(0), 300);
});

test('m9d016_http_lista_tools_so_para_ai_admin', { skip: SKIP }, async () => {
  const desligada = await env.call('GET', '/ai/tools', env.tokens['A:gestor']);
  assert.equal(desligada.status, 503);
  assert.equal(desligada.body.error.code, 'AI_FEATURE_DISABLED');
  const on = await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const semPerm = await env.call('GET', '/ai/tools', env.tokens['A:leitura']);
  assert.equal(semPerm.status, 403);
  assert.equal(semPerm.body.error.code, 'PERMISSION_DENIED');
  const semToken = await env.call('GET', '/ai/tools');
  assert.equal(semToken.status, 401);
  const ok = await env.call('GET', '/ai/tools', env.tokens['A:gestor']);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const tools = ok.body.data;
  assert.equal(tools.length, 13);
  const pagar = tools.find((t) => t.name === 'finance.proposePayment');
  assert.equal(pagar.riskLevel, 'CRITICAL');
  assert.equal(pagar.requiresHumanApproval, true);
  assert.equal(pagar.permissionCode, 'finance:create');
  assert.ok(tools.every((t) => t.execute === undefined && t.inputSchema && t.outputSchema));
});
