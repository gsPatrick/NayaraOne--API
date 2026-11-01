'use strict';

// M9-D825 (reabertura F18) — os perfis de CI "mascarado" e "claro" do seed existem para provar a máscara em TELA: o primeiro lê Pessoas e contas bancárias sem a permissão
// dedicada (CPF e conta mascarados), o segundo com ela (em claro). Rodar: node scripts/withDisposableDb.js --port <55000-56999> -- env CI_TENANT_USERS_PASSWORD=... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 <arquivo>"
process.env.PORT = process.env.M9D825_PERFIS_TEST_PORT || '21827';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PROFILES } = require('../../../scripts/seed-ci-two-tenants');
const env = require('../_helpers/m9d825Env');
const { startHttp, stopHttp } = require('../_helpers/m9d806Http');

test('m9d825 perfis de QA do seed: o par difere só pela permissão dedicada e ambos leem Pessoas e contas', () => {
  const masked = PROFILES.find((p) => p.key === 'mascarado');
  const clear = PROFILES.find((p) => p.key === 'claro');
  assert.ok(masked && clear, 'os dois perfis existem no seed');
  assert.ok(!masked.permissions.includes(env.VIEW_RESTRICTED));
  assert.ok(clear.permissions.includes(env.VIEW_RESTRICTED));
  assert.deepEqual(clear.permissions.filter((c) => c !== env.VIEW_RESTRICTED), masked.permissions);
  for (const code of ['people:read', 'finance:read']) assert.ok(masked.permissions.includes(code), code);
});

let http; let fx;
before(async () => {
  http = await startHttp({ port: process.env.PORT, grants: {}, logins: { gestorA: ['A', 'gestor'], mascarado: ['A', 'mascarado'], claro: ['A', 'claro'] } });
  if (http.skip) return;
  fx = await env.createFixtures(http, 'gestorA', 'perfis');
});
after(async () => {
  if (fx) await env.removeFixtures(fx);
  await stopHttp({});
});

test('m9d825 perfil mascarado vê CPF e conta mascarados; perfil em claro vê o valor (mesma ficha)', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const masked = await http.call('mascarado', 'GET', `/people/${fx.personId}`);
  assert.equal(masked.status, 200, JSON.stringify(masked.body));
  assert.equal(masked.body.data.taxIdNormalized, '***.***.***-25');
  const maskedAccount = await http.call('mascarado', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.equal(maskedAccount.status, 200, JSON.stringify(maskedAccount.body));
  assert.match(maskedAccount.body.data.accountNumber, /^\*{4}/);
  const clear = await http.call('claro', 'GET', `/people/${fx.personId}`);
  assert.equal(clear.status, 200, JSON.stringify(clear.body));
  assert.equal(clear.body.data.taxIdNormalized, env.CPF);
  const clearAccount = await http.call('claro', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.equal(clearAccount.body.data.accountNumber, env.ACCOUNT);
});
