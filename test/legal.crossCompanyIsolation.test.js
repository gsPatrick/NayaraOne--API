'use strict';

// JUR-013 (Multiempresa em contratos) — auditoria externa (Abacus AI, 11/10/2026): "Não
// testado com duas empresas." O catálogo genérico de RLS (test/rls.catalog.allTables.test.js)
// já confirma RLS+FORCE RLS+policy em 100% das tabelas multiempresa, incluindo
// legal.contracts — mas isso só prova que existe uma policy, não que ela bloqueia de fato uma
// leitura/escrita cross-company real. Mesmo padrão adversarial já usado no Marco 3
// (marco3.crossCompanyIsolation.test.js): muda o contexto de tenant DENTRO da mesma transação
// para uma empresa DIFERENTE e tenta ler/escrever a linha da empresa original, direto via SQL.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const guaranteesService = require('../src/features/legal/guarantees.service');

let tenant;
let otherCompanyId;

before(async () => {
  tenant = await getSeedTenant();
  const [[row]] = await sequelize.query('SELECT id FROM core.companies WHERE id != :companyId LIMIT 1', {
    replacements: { companyId: tenant.companyId },
  });
  otherCompanyId = row ? row.id : '00000000-0000-0000-0000-000000000000';
});

after(async () => {
  await sequelize.close();
});

test('JUR-013: legal.contracts — outra empresa não enxerga nem edita o contrato via SELECT/UPDATE direto', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [selectRows] = await sequelize.query('SELECT id FROM "legal"."contracts" WHERE id = :id', {
      replacements: { id: contract.id },
      transaction,
    });
    assert.equal(selectRows.length, 0, 'empresa diferente não deve conseguir SELECT no contrato da empresa original');

    const [, updateResult] = await sequelize.query(
      `UPDATE "legal"."contracts" SET total_value = 999999 WHERE id = :id`,
      { replacements: { id: contract.id }, transaction }
    );
    assert.equal(updateResult.rowCount, 0, 'empresa diferente não deve conseguir UPDATE no contrato da empresa original');
  });
});

test('JUR-013: legal.guarantees — outra empresa não enxerga a garantia vinculada ao contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    const guarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'DEPOSIT', value: 500 },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [selectRows] = await sequelize.query('SELECT id FROM "legal"."guarantees" WHERE id = :id', {
      replacements: { id: guarantee.id },
      transaction,
    });
    assert.equal(selectRows.length, 0, 'empresa diferente não deve conseguir SELECT na garantia da empresa original');
  });
});
