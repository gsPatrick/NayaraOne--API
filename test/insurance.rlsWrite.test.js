'use strict';

// Rodada 45 (auditoria "loop até secar", 2026-10-05): o RLS do Insurance Hub existe no banco
// (ENABLE/FORCE ROW LEVEL SECURITY + CREATE POLICY tenant_isolation, migration
// 20260101000272-create-procurement-insurance-hub.js), mas não havia nenhum teste automatizado
// comprovando o isolamento de ESCRITA cross-tenant nessas tabelas — mesmo padrão já cobrado em
// Obras (test/construction.rlsWrite.test.js, M6-66). Replica esse padrão pro Insurance Hub.
//
// NOTA: localmente o usuário de banco (DB_USER) é superuser do Postgres (confirmado via
// `SELECT rolsuper, rolbypassrls FROM pg_roles` = true/true nesta máquina), que bypassa RLS
// incondicionalmente mesmo com FORCE ROW LEVEL SECURITY — limitação do AMBIENTE de teste local,
// não um bug de aplicação (o runtime real roda como `nayara_runtime`, sem esse privilégio; a
// policy em si foi confirmada presente e correta via `pg_policies`). Mesma classe de limitação
// que já afeta outros testes de RLS pré-existentes neste projeto.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const insuranceService = require('../src/features/procurement/insurance.service');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query(
    'SELECT id FROM core.companies WHERE id != :companyId LIMIT 1',
    { replacements: { companyId: tenant.companyId } }
  );
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

test('RLS Insurance Hub: UPDATE direta em apólice de outra empresa é bloqueada (não só a leitura)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', {
      replacements: { otherCompanyId },
      transaction,
    });

    const [, updateResult] = await sequelize.query(
      `UPDATE "procurement"."insurance_policies" SET status = 'ACTIVE' WHERE id = :policyId`,
      { replacements: { policyId: policy.id }, transaction }
    );
    assert.equal(updateResult.rowCount, 0, 'UPDATE cross-tenant não deve afetar nenhuma linha (RLS bloqueia a escrita)');

    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: tenant.companyId },
      transaction,
    });
    const reloaded = await insuranceService.getPolicy(policy.id, transaction);
    assert.equal(reloaded.status, 'DRAFT', 'status original precisa continuar intacto após a tentativa de escrita cross-tenant');
  });
});
