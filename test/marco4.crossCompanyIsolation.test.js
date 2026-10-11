'use strict';

// FIN-TS-020 (RLS financeiro multiempresa) — auditoria externa (Abacus AI, 11/10/2026):
// "Apenas uma empresa; não comprovado." O catálogo genérico de RLS
// (test/rls.catalog.allTables.test.js) já confirma RLS+FORCE RLS+policy em 100% das tabelas
// multiempresa do schema finance, incluindo financial_entries, commissions e payment_intents —
// mas isso só prova que EXISTE uma policy, não que ela bloqueia de fato uma leitura/escrita
// cross-company real. Este arquivo reproduz o cenário adversarial ponta a ponta nas 3 tabelas
// centrais do Marco 4, no mesmo padrão já usado para Marco 3
// (marco3.crossCompanyIsolation.test.js) e Obras (construction.rlsWrite.test.js): muda o
// contexto de tenant DENTRO da mesma transação para uma empresa DIFERENTE e tenta ler/escrever
// a linha da empresa original, direto via SQL — bypassando toda a camada de serviço.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const commissionsService = require('../src/features/finance/commissions.service');
const paymentIntentsService = require('../src/features/finance/paymentIntents.service');

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

test('FIN-TS-020: financial_entries é isolado por EMPRESA — outra empresa do mesmo grupo nunca vê o lançamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const costCenter = await createTestCostCenter(tenant, transaction);
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, nature: 'PAYABLE', entryType: 'DEBIT',
        amount: 321, description: 'QA FIN-TS-020 isolamento', costCenterId: costCenter.id,
        idempotencyKey: `fin-ts-020-${uniqueSuffix()}`,
      },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [fromOtherCompany] = await sequelize.query('SELECT id FROM "finance"."financial_entries" WHERE id = :id', {
      replacements: { id: entry.id },
      transaction,
    });
    assert.equal(fromOtherCompany.length, 0, 'outra empresa (mesmo grupo) NUNCA deve ver o lançamento financeiro de outra empresa');

    await assert.rejects(
      () => sequelize.query('UPDATE "finance"."financial_entries" SET description = :d WHERE id = :id', {
        replacements: { d: 'forjado', id: entry.id },
        transaction,
      }).then(([, meta]) => {
        if (meta?.rowCount === 0) throw new Error('RLS_BLOCKED_NO_ROWS');
      }),
      () => true
    );
  });
});

test('FIN-TS-020: commissions é isolado por EMPRESA — outra empresa do mesmo grupo nunca vê a comissão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const { User } = require('../src/models');
    const [beneficiary] = await User.findOrCreate({
      where: { email: `homo-qa-fin-ts-020-${uniqueSuffix()}@nayaraone.dev` },
      defaults: { name: 'HOMO QA — Beneficiário FIN-TS-020', passwordHash: 'x', status: 'ACTIVE' },
    });
    const { commission } = await commissionsService.createCommission(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, beneficiaryUserId: beneficiary.id,
        baseAmount: 1000, percentage: 5, idempotencyKey: `fin-ts-020-comm-${uniqueSuffix()}`,
      },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [fromOtherCompany] = await sequelize.query('SELECT id FROM "finance"."commissions" WHERE id = :id', {
      replacements: { id: commission.id },
      transaction,
    });
    assert.equal(fromOtherCompany.length, 0, 'outra empresa (mesmo grupo) NUNCA deve ver a comissão de outra empresa');
  });
});

test('FIN-TS-020: payment_intents é isolado por EMPRESA — outra empresa do mesmo grupo nunca vê a intenção de pagamento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const costCenter = await createTestCostCenter(tenant, transaction);
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, nature: 'PAYABLE', entryType: 'DEBIT',
        amount: 654, description: 'QA FIN-TS-020 intent', costCenterId: costCenter.id,
        idempotencyKey: `fin-ts-020-entry-${uniqueSuffix()}`,
      },
      tenant.userId,
      transaction
    );
    const intent = await paymentIntentsService.createPaymentIntent(
      { groupId: tenant.groupId, companyId: tenant.companyId, financialEntryId: entry.id, idempotencyKey: `fin-ts-020-intent-${uniqueSuffix()}` },
      tenant.userId,
      transaction
    );

    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction });
    await sequelize.query('SET LOCAL app.company_id = :otherCompanyId', { replacements: { otherCompanyId }, transaction });

    const [fromOtherCompany] = await sequelize.query('SELECT id FROM "finance"."payment_intents" WHERE id = :id', {
      replacements: { id: intent.id },
      transaction,
    });
    assert.equal(fromOtherCompany.length, 0, 'outra empresa (mesmo grupo) NUNCA deve ver a intenção de pagamento de outra empresa');
  });
});
