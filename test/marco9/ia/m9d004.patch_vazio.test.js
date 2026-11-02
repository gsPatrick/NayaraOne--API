'use strict';

// M9-D004 (reabertura C1) — PATCH /ai/agents/:code/versions/:version: corpo sem campo alterável é 400 em português (como PUT /ai/budgets/:id);
// campo válido continua 200. Só roda no cluster descartável (login real do seed; nunca chama MFA nem forja token).

const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');

const CODE = `QA_M9_PATCH_${randomUUID().slice(0, 8).toUpperCase()}`;
const NOVA = {
  purpose: 'Agente de teste do PATCH vazio.', systemPolicy: 'Cite as fontes.', modelPolicy: { capability: 'chat' }, dataScopes: ['crm.opportunities'],
  limits: {}, criticality: 'NON_CRITICAL', tools: [{ toolName: 'crm.buscar', permissionCode: 'ai:read', riskLevel: 'LOW' }],
};

let env;
before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  env = await startHttpEnv(Number(process.env.M9D004_PATCH_TEST_PORT) || 21744, [['A', 'gestor']]);
});
after(async () => {
  if (!env) return;
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: false });
  setTimeout(() => process.exit(0), 300);
});

test('m9d004_patch_versao_corpo_vazio_400_e_campo_valido_200', { skip: SKIP }, async () => {
  const { call, tokens } = env; const gestor = tokens['A:gestor'];
  assert.equal((await call('PUT', '/settings/ia.habilitada', gestor, { value: true })).status, 200);
  const criada = await call('POST', `/ai/agents/${CODE}/versions`, gestor, NOVA, { 'Idempotency-Key': `qa-m9-patch-${CODE}` });
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  const antes = (await call('GET', `/ai/agents/${CODE}/versions/1`, gestor)).body.data;

  for (const corpo of [{}, { campoDesconhecido: 1 }]) {
    const vazio = await call('PATCH', `/ai/agents/${CODE}/versions/1`, gestor, corpo);
    assert.equal(vazio.status, 400, JSON.stringify(vazio.body));
    assert.equal(vazio.body.error.code, 'AI_AGENT_INVALID');
    assert.match(vazio.body.error.message, /Informe ao menos um campo para alterar/);
  }
  const depoisVazio = (await call('GET', `/ai/agents/${CODE}/versions/1`, gestor)).body.data;
  assert.equal(depoisVazio.purpose, antes.purpose);
  assert.equal(depoisVazio.configHash, antes.configHash);

  const ok = await call('PATCH', `/ai/agents/${CODE}/versions/1`, gestor, { purpose: 'Finalidade revisada pelo PATCH.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.purpose, 'Finalidade revisada pelo PATCH.');
});
