'use strict';

// Rodada 45 (auditoria "loop até secar", 2026-10-05): mesmo padrão de teste de isolamento de
// ESCRITA cross-tenant já cobrado em Obras (test/construction.rlsWrite.test.js, M6-66), agora
// pra Patrimônio/Estoque (Marco 7) — tabelas criadas/corrigidas nas rodadas 7-30 sem esse teste
// específico. NOTA: localmente o usuário de banco (DB_USER) é superuser do Postgres, que
// bypassa RLS incondicionalmente mesmo com FORCE ROW LEVEL SECURITY — mesma limitação de
// ambiente já documentada nos outros testes de RLS deste projeto (não é um bug de app; o
// runtime real roda como `nayara_runtime`, sem esse privilégio).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const assetsService = require('../src/features/inventory/assets.service');

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

test('RLS Patrimônio: UPDATE direta em asset de outra empresa é bloqueada (não só a leitura)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const asset = await assetsService.createAsset(
      withTenant({ name: `HOMO QA RLS Asset ${suffix}`, assetTag: `RLS-${suffix}` }),
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', {
      replacements: { otherCompanyId },
      transaction,
    });

    const [, updateResult] = await sequelize.query(
      `UPDATE "inventory"."assets" SET status = 'LOST' WHERE id = :assetId`,
      { replacements: { assetId: asset.id }, transaction }
    );
    assert.equal(updateResult.rowCount, 0, 'UPDATE cross-tenant não deve afetar nenhuma linha (RLS bloqueia a escrita)');

    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: tenant.companyId },
      transaction,
    });
    await asset.reload({ transaction });
    assert.equal(asset.status, 'AVAILABLE', 'status original precisa continuar intacto após a tentativa de escrita cross-tenant');
  });
});
