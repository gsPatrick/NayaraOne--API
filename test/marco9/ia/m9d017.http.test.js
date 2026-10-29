'use strict';

// M9-D017 — GET/POST/PATCH /v1/ai/service-identities por HTTP real: só ai:admin, só leitura, uma por empresa e agente,
// isolamento entre empresas e trilha de auditoria. Login real dos usuários do seed (nunca MFA nem token forjado).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, admin, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');

let env;
before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  await grant('CI LEITURA', ['ai:use']);
  env = await startHttpEnv(Number(process.env.M9D017_HTTP_TEST_PORT) || 21717, [['A', 'gestor'], ['B', 'gestor'], ['A', 'leitura']]);
});
after(async () => {
  if (!env) return;
  for (const t of ['A', 'B']) await env.call('PUT', '/settings/ia.habilitada', env.tokens[`${t}:gestor`], { value: false });
  setTimeout(() => process.exit(0), 300);
});

test('m9d017_http_service_identities_ciclo_e_recusas', { skip: SKIP }, async () => {
  const gA = env.tokens['A:gestor'];
  const desligada = await env.call('GET', '/ai/service-identities', gA);
  assert.equal(desligada.status, 503);
  for (const t of ['A', 'B']) assert.equal((await env.call('PUT', '/settings/ia.habilitada', env.tokens[`${t}:gestor`], { value: true })).status, 200);

  assert.equal((await env.call('GET', '/ai/service-identities')).status, 401);
  const semPerm = await env.call('GET', '/ai/service-identities', env.tokens['A:leitura']);
  assert.equal(semPerm.status, 403); assert.equal(semPerm.body.error.code, 'PERMISSION_DENIED');
  assert.equal((await env.call('POST', '/ai/service-identities', env.tokens['A:leitura'], { agentCode: 'NAY_HTTP', permissions: ['finance:read'] })).status, 403);

  // Escrita é recusada com o código e a mensagem do livro.
  const escrita = await env.call('POST', '/ai/service-identities', gA, { agentCode: 'NAY_HTTP', permissions: ['finance:read', 'finance:approve'] });
  assert.equal(escrita.status, 400);
  assert.equal(escrita.body.error.code, 'AI_SERVICE_IDENTITY_INVALID');
  assert.equal(escrita.body.error.message, 'A identidade de serviço só pode ter permissões de leitura.');

  const criada = await env.call('POST', '/ai/service-identities', gA, { agentCode: 'NAY_HTTP', permissions: ['finance:read'] });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  assert.equal(criada.body.data.agentCode, 'NAY_HTTP');
  assert.equal(criada.body.data.displayName.startsWith('service:NAY_HTTP@'), true);
  const id = criada.body.data.id;
  const repetida = await env.call('POST', '/ai/service-identities', gA, { agentCode: 'NAY_HTTP', permissions: ['finance:read'] });
  assert.equal(repetida.status, 409); assert.equal(repetida.body.error.code, 'AI_SERVICE_IDENTITY_EXISTS');

  const lista = await env.call('GET', '/ai/service-identities', gA);
  assert.equal(lista.status, 200);
  assert.ok(lista.body.data.some((i) => i.id === id));
  // A empresa B não vê nem altera a identidade da A.
  const listaB = await env.call('GET', '/ai/service-identities', env.tokens['B:gestor']);
  assert.ok(!listaB.body.data.some((i) => i.id === id));
  const outra = await env.call('PATCH', `/ai/service-identities/${id}`, env.tokens['B:gestor'], { enabled: false });
  assert.equal(outra.status, 404);

  const promover = await env.call('PATCH', `/ai/service-identities/${id}`, gA, { permissions: ['finance:read', 'finance:settle'] });
  assert.equal(promover.status, 400); assert.equal(promover.body.error.code, 'AI_SERVICE_IDENTITY_INVALID');
  const desligar = await env.call('PATCH', `/ai/service-identities/${id}`, gA, { enabled: false });
  assert.equal(desligar.status, 200);
  assert.equal(desligar.body.data.enabled, false);

  // Trilha de auditoria da criação e da alteração, com antes e depois.
  const { rows } = await admin(`SELECT action, before_json, after_json FROM audit.audit_log WHERE entity_type = 'AiServiceIdentity' AND entity_id = $1 ORDER BY created_at`, [id]);
  assert.deepEqual(rows.map((r) => r.action), ['ai.service_identity.create', 'ai.service_identity.update']);
  assert.equal(rows[1].before_json.enabled, true);
  assert.equal(rows[1].after_json.enabled, false);
});
