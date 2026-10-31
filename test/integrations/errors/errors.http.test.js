'use strict';

// Marco 9, M9-D207 — rotas GET /v1/admin/integrations/errors e POST .../:id/resolve (HTTP real, permissão real).
// Roda em banco descartável (grava e apaga linhas COMMITADAS). Tokens assinados só pelo teste, contra o app de teste.

process.env.PORT = process.env.INTEGRATION_ERRORS_HTTP_TEST_PORT || require('../../marco9/_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('../../../app');
const { sequelize, getSeedTenant } = require('../../testHelpers');
const { signAccessToken } = require('../../../src/utils/jwt');
const errors = require('../../../src/features/integrations/errors');

let tenant;
let baseUrl;
let ctx;
let tokenRead;
let tokenRetry;
const ids = [];

const sessao = (permissions) => signAccessToken({
  sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'], permissions,
});

async function comoTenant(fn) {
  const transaction = await sequelize.transaction();
  try {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction });
    const r = await fn(transaction);
    await transaction.commit();
    return r;
  } catch (err) {
    await transaction.rollback().catch(() => {});
    throw err;
  }
}

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
  tokenRead = sessao(['integration:read']);
  tokenRetry = sessao(['integration:read', 'integration:retry']);
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

after(async () => {
  // M9-D244: o runtime não apaga erros de integração (só integration.purge_expired()); as linhas de teste são encerradas em vez de apagadas.
  await comoTenant((t) => sequelize.query("UPDATE integration.integration_errors SET status = 'IGNORED' WHERE id IN (:ids) AND status = 'OPEN'", { replacements: { ids: ids.length ? ids : ['00000000-0000-0000-0000-000000000000'] }, transaction: t }));
  await sequelize.close();
  process.exit(0);
});

const chamar = (token, method, path, body) => fetch(`${baseUrl}${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body !== undefined ? JSON.stringify(body) : undefined,
});

test('errors_http_lista_resolve_e_permissoes', async () => {
  const e = await comoTenant((t) => errors.recordError(ctx, {
    providerCode: 'financing-sandbox', source: 'DISPATCH', errorClass: 'AUTH', errorCode: 'QA_M9_HTTP', message: 'Credencial recusada pelo fornecedor.',
    payload: { status: 'DENIED', cpf: '123.456.789-09', token: 'abc' },
  }, t));
  ids.push(e.id);

  const lista = await chamar(tokenRead, 'GET', '/admin/integrations/errors?status=OPEN&source=DISPATCH');
  assert.equal(lista.status, 200);
  const corpo = await lista.json();
  const item = corpo.data.items.find((i) => i.id === e.id);
  assert.ok(item, 'o erro de dispatch aparece na listagem');
  assert.equal(item.severity, 'HIGH');
  assert.deepEqual(item.sanitizedPayload, { status: 'DENIED', cpf: '[REDACTED]', token: '[REDACTED]' });
  assert.equal(corpo.data.retentionDays, 180);
  assert.equal((await chamar(tokenRead, 'GET', '/admin/integrations/errors?status=XYZ')).status, 422, 'filtro inválido: 422 VALIDATION_ERROR (M9-D249)');

  const semPermissao = await chamar(tokenRead, 'POST', `/admin/integrations/errors/${e.id}/resolve`, { note: 'Credencial renovada' });
  assert.equal(semPermissao.status, 403, 'resolver exige integration:retry');
  const semNota = await chamar(tokenRetry, 'POST', `/admin/integrations/errors/${e.id}/resolve`, {});
  assert.equal(semNota.status, 422);
  assert.equal((await semNota.json()).error.code, 'INTEGRATION_ERROR_NOTE_REQUIRED');
  const ok = await chamar(tokenRetry, 'POST', `/admin/integrations/errors/${e.id}/resolve`, { note: 'Credencial renovada pelo operador' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.status, 'RESOLVED');
  const denovo = await chamar(tokenRetry, 'POST', `/admin/integrations/errors/${e.id}/resolve`, { note: 'Credencial renovada pelo operador' });
  assert.equal(denovo.status, 409);
  const inexistente = await chamar(tokenRetry, 'POST', '/admin/integrations/errors/00000000-0000-4000-8000-000000000000/resolve', { note: 'qualquer nota' });
  assert.equal(inexistente.status, 404);
  const malformado = await chamar(tokenRetry, 'POST', '/admin/integrations/errors/nao-e-uuid/resolve', { note: 'qualquer nota' });
  assert.equal(malformado.status, 400);
});
