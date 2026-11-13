'use strict';

// Marco 3, CRM-TS-013 / livro §18 ("Exportar base de clientes — Permissão, MFA, volume limit, audit"): o limite de volume da exportação de
// oportunidades é o teto da classe HIGH na política de DLP da empresa (parâmetro `governanca.dlp.volume_teto_por_classe`, editável pelo
// admin, padrão HIGH 10000), aplicado pelo guard do caminho vivo POST /exports. Acima do teto o pedido é recusado (422), nunca truncado;
// a estimativa que o guard recebe é a contagem real das linhas do catálogo. Prova pela rota em test/m3cb.exportacao.http.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { Person, Opportunity } = require('../src/models');
const policyService = require('../src/features/core-governance/dlp/policy.service');
const { withOwnTenantTransaction } = require('../src/features/core-governance/dlp/guard.tx');
const { decideExport, ENTRY } = require('./helpers/m3cbExportGuard');
const { readCrmExportMaxRows } = require('../src/features/crm/opportunitiesExport.settings');

const PERMS = ['governance:dlp:export', 'crm:opportunities:export', 'crm:opportunities:read'];

after(async () => {
  await sequelize.close();
});

async function highExportMaxRows(tenant) {
  return withOwnTenantTransaction(tenant, tenant.userId, async (t) => (await policyService.getPolicy(tenant, 'HIGH', 'EXPORT', t)).maxRows);
}

test('CRM-TS-013: exportação acima do limite de volume é recusada, não truncada', async () => {
  const tenant = await getSeedTenant();
  const maxRows = await highExportMaxRows(tenant);
  assert.ok(Number.isInteger(maxRows) && maxRows > 0, 'a política HIGH/EXPORT tem teto de linhas');
  const { decision, error } = await decideExport(tenant, { permissions: PERMS, mfaOk: true, estimatedRows: maxRows + 1 });
  assert.equal(decision.blockReason, 'VOLUME');
  assert.equal(error.statusCode, 422);
  assert.equal(error.code, 'GOV_DLP_VOLUME_EXCEEDED');
  assert.equal(decision.job.status, 'BLOCKED');
});

test('CRM-TS-013: exportação dentro do limite de volume funciona normalmente', async () => {
  const tenant = await getSeedTenant();
  const maxRows = await highExportMaxRows(tenant);
  const { decision, error } = await decideExport(tenant, { permissions: PERMS, mfaOk: true, estimatedRows: maxRows });
  assert.equal(error, null);
  assert.equal(decision.decision, 'ALLOW');
});

test('CRM-TS-013: a estimativa que vai ao teto é a contagem real das linhas a exportar (o arquivo nunca sai menor que o pedido)', async () => {
  const tenant = await getSeedTenant();
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const person = await Person.create({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Lead volume ${uniqueSuffix()}` }, { transaction });
    const rows = Array.from({ length: 7 }, () => ({ groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, stage: 'NEW', createdBy: tenant.userId, updatedBy: tenant.userId }));
    await Opportunity.bulkCreate(rows, { transaction });
    const ctx = { groupId: tenant.groupId, companyId: tenant.companyId, userId: tenant.userId };
    assert.equal(await ENTRY.estimate(ctx, { personId: person.id }, transaction), 7);
    assert.equal((await ENTRY.collect(ctx, { personId: person.id }, transaction)).rows.length, 7);
  });
});

test('CRM-TS-013 DEC-049: o teto próprio da exportação do CRM (exportacao.crm.linhas_maximo, padrão 5000) vence o da classe quando é menor', async () => {
  const tenant = await getSeedTenant();
  const cap = await withOwnTenantTransaction(tenant, tenant.userId, (t) => readCrmExportMaxRows(tenant, t));
  assert.equal(cap, 5000, 'padrão do catálogo de parâmetros');
  const acima = await decideExport(tenant, { permissions: PERMS, mfaOk: true, estimatedRows: cap + 1, maxRowsCap: cap });
  assert.equal(acima.decision.blockReason, 'VOLUME');
  assert.equal(acima.decision.trace.find((t) => t.step === 'VOLUME').maxRows, cap);
  const noTeto = await decideExport(tenant, { permissions: PERMS, mfaOk: true, estimatedRows: cap, maxRowsCap: cap });
  assert.equal(noTeto.decision.decision, 'ALLOW');
  assert.equal(typeof ENTRY.volumeCap, 'function', 'o catálogo do CRM declara o teto próprio');
});
