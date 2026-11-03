'use strict';

// Marco 8 — tabelas do caderno existem com RLS forçado.
// tax_documents fica em finance (já existia). proposals (propostas do banco) fica em correspondent.
// fiscal_calendar é a agenda em fiscal_obligations.due_at (o caderno escreve os dois no mesmo item).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('../testHelpers');
const { ProviderAccount, IntegrationError } = require('../../src/models');

const TABELAS = [
  ['correspondent', 'financing_cases'],
  ['correspondent', 'case_applicants'],
  ['correspondent', 'case_requirements'],
  ['correspondent', 'case_documents'],
  ['correspondent', 'simulations'],
  ['correspondent', 'provider_submissions'],
  ['correspondent', 'provider_status_history'],
  ['correspondent', 'proposals'],
  ['correspondent', 'appraisals'],
  ['correspondent', 'commission_entitlements'],
  ['correspondent', 'provider_accounts'],
  ['correspondent', 'integration_errors'],
  ['finance', 'tax_documents'],
  ['correspondent', 'invoice_requests'],
  ['correspondent', 'invoice_events'],
  ['correspondent', 'fiscal_obligations'],
  ['correspondent', 'accounting_export_batches'],
  ['correspondent', 'accounting_export_lines'],
  ['correspondent', 'accounting_return_imports'],
  ['correspondent', 'dimob_records'],
  ['correspondent', 'dimob_batches'],
  ['correspondent', 'fiscal_reconciliations'],
];

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

test('M8-TAB-01: cada tabela do caderno existe com RLS forçado', async () => {
  for (const [schema, table] of TABELAS) {
    const [[row]] = await sequelize.query(
      `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = :schema AND c.relname = :table`,
      { replacements: { schema, table } }
    );
    assert.ok(row, `${schema}.${table} não existe`);
    assert.equal(row.rls, true, `${schema}.${table} sem RLS`);
    assert.equal(row.forced, true, `${schema}.${table} sem FORCE RLS`);
  }
});

test('M8-TAB-02: o calendário fiscal do caderno é o vencimento da obrigação', async () => {
  const [[row]] = await sequelize.query(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_schema = 'correspondent' AND table_name = 'fiscal_obligations' AND column_name = 'due_at'`
  );
  assert.ok(row, 'fiscal_obligations.due_at é o calendário fiscal do caderno');
});

test('M8-TAB-03: conta de provider e erro de integração não vazam para outra empresa', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const account = await ProviderAccount.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        providerCode: `sbx${suffix}`.slice(0, 32),
        label: `conta ${suffix}`,
        secretRef: `vault:correspondent:${suffix}`,
      },
      { transaction }
    );
    const error = await IntegrationError.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        providerCode: 'sandbox',
        operation: 'submitCase',
        errorCode: 'TIMEOUT',
        message: 'Tempo esgotado aguardando o provider.',
      },
      { transaction }
    );

    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: otherCompanyId },
      transaction,
    });
    const contaAlheia = await ProviderAccount.findByPk(account.id, { transaction });
    const erroAlheio = await IntegrationError.findByPk(error.id, { transaction });
    assert.equal(contaAlheia, null);
    assert.equal(erroAlheio, null);

    await sequelize.query('SET LOCAL app.company_id = :companyId', {
      replacements: { companyId: tenant.companyId },
      transaction,
    });
    assert.ok(await ProviderAccount.findByPk(account.id, { transaction }));
    assert.ok(await IntegrationError.findByPk(error.id, { transaction }));
    assert.equal(account.secretRef.startsWith('vault:'), true);
    assert.equal(account.secretRef.includes('senha'), false);
  });
});
