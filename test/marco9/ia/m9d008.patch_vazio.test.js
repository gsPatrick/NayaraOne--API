'use strict';

// M9-D008 (reabertura C1) — PATCH /ai/knowledge/:id: corpo sem campo alterável é 400 em português (como PUT /ai/budgets/:id);
// campo válido continua 200. Só roda no cluster descartável (login real do seed; nunca chama MFA nem forja token).

const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DISPOSABLE, SKIP, grant, startHttpEnv } = require('../_helpers/aiHttpEnv');

const FK = `politica.patch.vazio.${randomUUID().slice(0, 8)}`;
const NOVA = { factKey: FK, subjectType: 'politica', title: 'Desconto máximo', value: { percentual: 5 }, classification: 'INTERNAL' };

let env;
before(async () => {
  if (!DISPOSABLE) return;
  await grant('CI GESTOR', ['ai:admin', 'ai:use', 'ai:read', 'settings:read', 'settings:update']);
  env = await startHttpEnv(Number(process.env.M9D008_PATCH_TEST_PORT) || 21748, [['A', 'gestor']]);
});
after(async () => {
  if (!env) return;
  await env.call('PUT', '/settings/ia.habilitada', env.tokens['A:gestor'], { value: false });
  setTimeout(() => process.exit(0), 300);
});

test('m9d008_patch_conhecimento_corpo_vazio_400_e_campo_valido_200', { skip: SKIP }, async () => {
  const { call, tokens } = env; const gestor = tokens['A:gestor'];
  assert.equal((await call('PUT', '/settings/ia.habilitada', gestor, { value: true })).status, 200);
  const criada = await call('POST', '/ai/knowledge', gestor, NOVA);
  assert.equal(criada.status, 201, JSON.stringify(criada.body));
  const id = criada.body.data.id;
  const antes = (await call('GET', `/ai/knowledge/${id}`, gestor)).body.data;

  const vazio = await call('PATCH', `/ai/knowledge/${id}`, gestor, {});
  assert.equal(vazio.status, 400, JSON.stringify(vazio.body));
  assert.equal(vazio.body.error.code, 'AI_KNOWLEDGE_INVALID');
  assert.match(vazio.body.error.message, /Informe ao menos um campo para alterar/);
  const depois = (await call('GET', `/ai/knowledge/${id}`, gestor)).body.data;
  assert.equal(depois.title, antes.title);
  assert.equal(depois.contentHash, antes.contentHash);

  const ok = await call('PATCH', `/ai/knowledge/${id}`, gestor, { title: 'Desconto máximo revisado' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.title, 'Desconto máximo revisado');
});
