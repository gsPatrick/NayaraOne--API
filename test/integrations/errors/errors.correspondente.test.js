'use strict';

// Marco 9, M9-D207 — o serviço de erros do Correspondente passa a delegar à tabela genérica
// (integration.integration_errors) sem mudar assinaturas nem códigos; a cópia do legado é idempotente.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('../../testHelpers');
const legacy = require('../../../src/features/correspondent/integrationErrors.service');
const errors = require('../../../src/features/integrations/errors');

let tenant;
let ctx;

before(async () => {
  tenant = await getSeedTenant();
  ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
});

after(async () => {
  await sequelize.close();
});

const codigo = (code) => (err) => { assert.equal(err.code, code); return true; };

test('errors_correspondente_mesma_assinatura', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const caso = randomUUID();
    const [[antesLegado]] = await sequelize.query('SELECT count(*)::int AS n FROM correspondent.integration_errors', { transaction: t });
    assert.equal(legacy.recordIntegrationError.length, 2);
    const e = await legacy.recordIntegrationError(
      { groupId: tenant.groupId, companyId: tenant.companyId, financingCaseId: caso, providerCode: 'sandbox', operation: 'submit', errorCode: 'PROVIDER_DOWN', message: 'Falha para a@b.com no envio.' }, t);
    assert.ok(e.id);
    assert.equal(e.financingCaseId, caso);
    assert.equal(e.operation, 'submit');
    assert.equal(e.status, 'OPEN');
    assert.ok(!e.message.includes('a@b.com'), 'a mensagem passa pelo sanitizador único');
    const [[naGenerica]] = await sequelize.query('SELECT source, source_ref_id FROM integration.integration_errors WHERE id = :id', { replacements: { id: e.id }, transaction: t });
    assert.equal(naGenerica.source, 'DISPATCH');
    assert.equal(naGenerica.source_ref_id, caso, 'financing_case_id fica em source_ref_id');
    const [[depoisLegado]] = await sequelize.query('SELECT count(*)::int AS n FROM correspondent.integration_errors', { transaction: t });
    assert.equal(depoisLegado.n, antesLegado.n, 'a tabela antiga não recebe mais linhas');

    const abertos = await legacy.listIntegrationErrors({ status: 'OPEN' }, tenant.groupId, tenant.companyId, t);
    const achado = abertos.find((x) => x.id === e.id);
    assert.equal(achado.operationLabel, 'Envio do caso');
    assert.equal(achado.financingCaseId, caso);
    await assert.rejects(legacy.listIntegrationErrors({ status: 'QUALQUER' }, tenant.groupId, tenant.companyId, t), codigo('INTEGRATION_ERROR_VALIDATION'));
    await assert.rejects(legacy.resolveIntegrationError(e.id, '', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('INTEGRATION_ERROR_VALIDATION'));
    const r = await legacy.resolveIntegrationError(e.id, 'Provider voltou, reenviado', tenant.userId, tenant.groupId, tenant.companyId, t);
    assert.equal(r.status, 'RESOLVED');
    await assert.rejects(legacy.resolveIntegrationError(e.id, 'de novo', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('INTEGRATION_ERROR_ALREADY_RESOLVED'));
    await assert.rejects(legacy.resolveIntegrationError(randomUUID(), 'nota', tenant.userId, tenant.groupId, tenant.companyId, t), codigo('INTEGRATION_ERROR_NOT_FOUND'));
  });
});

test('errors_migracao_idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await sequelize.query("SET LOCAL app.integration_legacy_write = 'on'", { transaction: t });
    const ids = [randomUUID(), randomUUID()];
    await sequelize.query(
      `INSERT INTO correspondent.integration_errors (id, group_id, company_id, financing_case_id, provider_code, operation, error_code, message, status, created_at, updated_at)
       VALUES (:i1, :g, :c, NULL, 'sandbox', 'submit', 'LEGADO_1', 'Falha antiga um', 'OPEN', now(), now()),
              (:i2, :g, :c, NULL, 'sandbox', 'webhook', 'LEGADO_2', 'Falha antiga dois', 'RESOLVED', now(), now())`,
      { replacements: { i1: ids[0], i2: ids[1], g: tenant.groupId, c: tenant.companyId }, transaction: t });
    const primeira = await errors.migrateLegacyIntegrationErrors(ctx, t);
    assert.ok(primeira.inserted >= 2);
    const segunda = await errors.migrateLegacyIntegrationErrors(ctx, t);
    assert.equal(segunda.inserted, 0, 'rodar de novo não duplica');
    const [linhas] = await sequelize.query('SELECT id, source, status, error_code, operation FROM integration.integration_errors WHERE id IN (:ids) ORDER BY error_code', { replacements: { ids }, transaction: t });
    assert.equal(linhas.length, 2);
    assert.ok(linhas.every((l) => l.source === 'DISPATCH'));
    assert.equal(linhas[0].status, 'OPEN');
    assert.equal(linhas[1].status, 'RESOLVED');
    assert.equal(linhas[0].operation, 'submit');
  });
});

test('errors_tabela_antiga_somente_leitura', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    await sequelize.query('SAVEPOINT s1', { transaction: t });
    await assert.rejects(sequelize.query(
      `INSERT INTO correspondent.integration_errors (group_id, company_id, provider_code, operation, error_code, message, status)
       VALUES (:g, :c, 'sandbox', 'submit', 'X', 'm', 'OPEN')`, { replacements: { g: tenant.groupId, c: tenant.companyId }, transaction: t }), /somente leitura/);
  });
});
