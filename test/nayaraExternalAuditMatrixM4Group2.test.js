'use strict';

// Fecha a cobertura real (Postgres + RLS + HTTP) de parte da matriz da auditoria complementar da
// Nayara (14/10/2026, Seção 4 — "Marco 4 — Financeiro"), grupo 2 de 2 (o outro agente desta
// mesma rodada cobre repasses/caução — ver test/nayaraExternalAuditMatrixM4Group1.test.js).
// Este arquivo cobre:
//  - "Plano de contas... negar usuário comum" — usuário sem finance:create recebe 403 real na
//    rota HTTP, não só documentação de que a permissão existe.
//  - "Ledger append-only — UPDATE/DELETE direto bloqueados por banco" — GAP REAL ENCONTRADO E
//    CORRIGIDO: antes da migration 20260101000366, nada no banco impedia um UPDATE/DELETE cru
//    em finance.financial_entries fora da camada de serviço. Ver comentário completo na
//    migration. Este teste prova a garantia a nível de SQL puro, contornando deliberadamente o
//    service (é exatamente o cenário que a auditoria pediu: "tentando fazer o UPDATE/DELETE raw
//    via SQL e esperando erro").
//
// NOTA OPERACIONAL: a migration 20260101000366 precisa ser aplicada no banco (via
// `npx sequelize-cli db:migrate --env migration`, credencial de DDL) antes deste arquivo passar.
// Rodar DDL contra o banco compartilhado de homologação é uma ação sensível que o classificador
// de permissão do Claude Code bloqueia para um agente — precisa de aprovação humana explícita.
// Até a migration rodar, os dois testes de append-only abaixo falham deliberadamente (red),
// documentando o gap em vez de escondê-lo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.MARCO4_GROUP2_HTTP_TEST_PORT || '34597';

const app = require('../app');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const chartOfAccountsService = require('../src/features/finance/chartOfAccounts.service');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const { CostCenter } = require('../src/models');

let tenant;
let baseUrl;

after(async () => {
  await sequelize.close();
});

before(async () => {
  tenant = await getSeedTenant();
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((resolve) => setTimeout(resolve, 300));
});

test('Plano de contas (HTTP real): usuário SEM finance:create recebe 403 ao tentar criar conta contábil', async () => {
  const tokenWithoutPermission = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['member'],
    permissions: ['finance:read'],
  });

  const res = await fetch(`${baseUrl}/finance/chart-of-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenWithoutPermission}` },
    body: JSON.stringify({
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      code: `NEGADO-${uniqueSuffix()}`,
      name: 'Tentativa sem permissão',
      accountType: 'EXPENSE',
    }),
  });

  assert.equal(res.status, 403, 'usuário sem finance:create deveria receber 403, não conseguir criar conta contábil');
});

test('Plano de contas (HTTP real): usuário COM finance:create consegue criar conta contábil e ela aparece na listagem', async () => {
  const tokenWithPermission = signAccessToken({
    sub: tenant.userId,
    group_id: tenant.groupId,
    company_id: tenant.companyId,
    roles: ['admin'],
    permissions: ['finance:create', 'finance:read'],
  });
  const code = `PERMITIDO-${uniqueSuffix()}`;

  const createRes = await fetch(`${baseUrl}/finance/chart-of-accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenWithPermission}` },
    body: JSON.stringify({ groupId: tenant.groupId, companyId: tenant.companyId, code, name: 'Conta permitida', accountType: 'EXPENSE' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  const listRes = await fetch(`${baseUrl}/finance/chart-of-accounts?accountType=EXPENSE`, {
    headers: { Authorization: `Bearer ${tokenWithPermission}` },
  });
  const listed = await listRes.json();
  assert.ok(
    listed.data.some((a) => a.id === created.data.id),
    'conta recém-criada deveria aparecer na listagem filtrada por tipo'
  );

  await sequelize.query('DELETE FROM finance.chart_of_accounts WHERE id = :id', {
    replacements: { id: created.data.id },
  });
});

test('Ledger append-only (SQL cru, banco real): DELETE direto em finance.financial_entries é bloqueado pelo trigger de banco, não pelo service', async () => {
  const t = tenant;
  await withRollbackTenantTransaction(t, async (transaction) => {
    const costCenter = await CostCenter.create(
      { groupId: t.groupId, companyId: t.companyId, code: `CC-APPEND-${uniqueSuffix()}`, name: 'Append-only guard' },
      { transaction }
    );
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: t.groupId,
        companyId: t.companyId,
        entryType: 'PAYABLE',
        nature: 'PAYABLE',
        amount: '150.00',
        dueAt: '2030-01-10',
        costCenterId: costCenter.id,
      },
      t.userId,
      transaction
    );

    await assert.rejects(
      () => sequelize.query('DELETE FROM finance.financial_entries WHERE id = :id', { replacements: { id: entry.id }, transaction }),
      /append-only/i,
      'DELETE cru em financial_entries deveria ser recusado pelo banco (trigger), não silenciosamente aceito'
    );
  });
});

test('Ledger append-only (SQL cru, banco real): UPDATE direto mudando "amount" é bloqueado pelo trigger de banco', async () => {
  const t = tenant;
  await withRollbackTenantTransaction(t, async (transaction) => {
    const costCenter = await CostCenter.create(
      { groupId: t.groupId, companyId: t.companyId, code: `CC-APPEND2-${uniqueSuffix()}`, name: 'Append-only guard 2' },
      { transaction }
    );
    const entry = await financialEntriesService.createFinancialEntry(
      {
        groupId: t.groupId,
        companyId: t.companyId,
        entryType: 'PAYABLE',
        nature: 'PAYABLE',
        amount: '200.00',
        dueAt: '2030-01-10',
        costCenterId: costCenter.id,
      },
      t.userId,
      transaction
    );

    await assert.rejects(
      () =>
        sequelize.query('UPDATE finance.financial_entries SET amount = 999999.00 WHERE id = :id', {
          replacements: { id: entry.id },
          transaction,
        }),
      /append-only/i,
      'UPDATE cru mudando "amount" deveria ser recusado pelo banco (trigger), não silenciosamente aceito'
    );

    // Confirma que um UPDATE em campo que o fluxo normal de fato muta (ex.: updated_by) continua
    // funcionando — o trigger não deve travar a operação legítima da aplicação.
    await sequelize.query('UPDATE finance.financial_entries SET updated_by = :uid WHERE id = :id', {
      replacements: { uid: t.userId, id: entry.id },
      transaction,
    });
  });
});
