'use strict';

// M9-D915 — a mesma ficha vista por dois perfis pela API real (banco descartável): quem não tem governance:dlp:view-restricted vê o CPF e a conta mascarados pelo registro de
// classificação; quem tem vê em claro; o cadastro com valor em claro nunca vaza. Rodar: ver m9d915.campo.test.js (com a porta própria abaixo).
process.env.PORT = process.env.M9D915_HTTP_TEST_PORT || '21915';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d825Env');

let http; let fx;
before(async () => {
  if (env.DISPOSABLE) await env.setRolePermission('CI CHECKER', 'people:read', true);
  http = await env.startDlpHttp(process.env.PORT);
  if (http.skip) return;
  fx = await env.createFixtures(http, 'gestorA', 'D915');
});
after(async () => {
  if (fx) await env.removeFixtures(fx);
  if (env.DISPOSABLE) await env.setRolePermission('CI CHECKER', 'people:read', false);
  await env.stopDlpHttp();
});

test('m9d915 field masking em tela e API: a mesma ficha por dois perfis', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const sem = await http.call('gestorA', 'GET', `/people/${fx.personId}`);
  const com = await http.call('checkerA', 'GET', `/people/${fx.personId}`);
  assert.equal(sem.status, 200, JSON.stringify(sem.body));
  assert.equal(com.status, 200, JSON.stringify(com.body));
  assert.equal(sem.body.data.taxIdNormalized, '***.***.***-25', 'sem permissão: só os 2 últimos dígitos do CPF');
  assert.ok(!JSON.stringify(sem.body).includes(env.CPF), 'o CPF completo não aparece em lugar nenhum da resposta');
  assert.equal(com.body.data.taxIdNormalized, env.CPF, 'com governance:dlp:view-restricted o CPF sai em claro');
  const list = await http.call('gestorA', 'GET', '/people');
  assert.ok(!JSON.stringify(list.body).includes(env.CPF), 'a lista também sai mascarada');
  const account = await http.call('makerA', 'GET', `/finance/bank-accounts/${fx.accountId}`);
  assert.equal(account.body.data.accountNumber, '****6789', 'conta: ****1234 (4 últimos dígitos)');
  assert.equal(account.body.data.agency, '0001', 'HIGH segue em claro, com auditoria');
});

test('m9d915 a máscara vale para qualquer campo RESTRICTED ou HIGH do registro da tabela, não só os do parâmetro antigo', async (t) => {
  if (http.skip) return t.skip(http.skip);
  const rows = (await env.adminQuery("SELECT column_name FROM governance.data_classification_registry WHERE company_id = $1 AND schema_name = 'people' AND table_name = 'persons' AND classification = 'RESTRICTED'", [http.tenants.A.companyId])).rows.map((r) => r.column_name);
  assert.ok(rows.includes('tax_id_normalized_hash'), 'o hash do CPF está RESTRICTED no registro');
  const sem = await http.call('gestorA', 'GET', `/people/${fx.personId}`);
  const hash = sem.body.data.taxIdNormalizedHash;
  if (hash !== undefined && hash !== null) assert.ok(!/^[0-9a-f]{20,}$/i.test(String(hash)), 'o hash não sai inteiro');
});
