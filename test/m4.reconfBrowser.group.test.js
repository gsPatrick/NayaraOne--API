'use strict';

// Conferência ao vivo do Marco 4 (20/10/2026): a conciliação em grupo N:1 existia só no serviço e
// não tinha rota HTTP — a tela não conseguia usá-la. Prova pela rota real: 403 sem permissão,
// 201 quando a soma bate, 409 FINANCE_RECONCILIATION_AMOUNT_MISMATCH quando não bate.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4_GROUP_HTTP_TEST_PORT || '21633';
require('../app');
const { getSeedTenant, uniqueSuffix, withTenantTransaction, sequelize: seq } = require('./testHelpers');
const { signAccessToken } = require('../src/utils/jwt');
const { BankAccount, BankTransaction, FinancialEntry, Reconciliation, ResultCenter } = require('../src/models');

let tenant; let baseUrl; let tokenOk; let tokenSemPermissao;
const created = { accounts: [], txs: [], entries: [], centers: [] };

before(async () => {
  tenant = await getSeedTenant();
  const base = { sub: tenant.userId, group_id: tenant.groupId, company_id: tenant.companyId, roles: ['admin'] };
  tokenOk = signAccessToken({ ...base, permissions: ['finance:reconcile', 'finance:read', 'finance:create'] });
  tokenSemPermissao = signAccessToken({ ...base, permissions: ['finance:read'] });
  baseUrl = `http://127.0.0.1:${process.env.PORT}/api/v1`;
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  try {
    await withTenantTransaction(tenant, async (t) => {
      await Reconciliation.destroy({ where: { financialEntryId: created.entries }, force: true, transaction: t }).catch(() => {});
    });
  } catch (_e) { /* o trigger de só-inclusão pode recusar; rodando no descartável, o banco some */ }
  await seq.close().catch(() => {});
  process.exit(0);
});

async function http(token, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function seed(amounts, txAmount) {
  const sfx = uniqueSuffix();
  return withTenantTransaction(tenant, async (transaction) => {
    const account = await BankAccount.create({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `GRP-${sfx}`, pixKey: `grp-${sfx}@t.dev`, status: 'ACTIVE' }, { transaction });
    const rc = await ResultCenter.create({ groupId: tenant.groupId, companyId: tenant.companyId, code: `GRP-${sfx}`, name: `Centro grupo ${sfx}` }, { transaction });
    created.accounts.push(account.id); created.centers.push(rc.id);
    const entries = [];
    for (const amount of amounts) {
      const e = await FinancialEntry.create({ groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount, description: `Grupo ${sfx}`, status: 'PENDING', bankAccountId: account.id, resultCenterId: rc.id, competenceMonth: '2026-10', idempotencyKey: `grp-${sfx}-${amount}-${entries.length}` }, { transaction });
      entries.push(e); created.entries.push(e.id);
    }
    const tx = await BankTransaction.create({ groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: account.id, externalTransactionId: `GRP-${sfx}`, amount: txAmount, transactionDate: new Date() }, { transaction });
    created.txs.push(tx.id);
    return { entries, tx };
  });
}

test('POST /finance/reconciliations/group: sem finance:reconcile é 403', async () => {
  const r = await http(tokenSemPermissao, 'POST', '/finance/reconciliations/group', { financialEntryIds: [], bankTransactionIds: [] });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PERMISSION_DENIED');
});

test('POST /finance/reconciliations/group: dois lançamentos de R$ 50 conciliam com uma transação de R$ 100 (201)', async () => {
  const { entries, tx } = await seed([50, 50], 100);
  const r = await http(tokenOk, 'POST', '/finance/reconciliations/group', { financialEntryIds: entries.map((e) => e.id), bankTransactionIds: [tx.id] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.totalAmount, '100.00');
  assert.equal(r.body.data.reconciliations.length, 2);
});

test('POST /finance/reconciliations/group: soma que não bate é 409 FINANCE_RECONCILIATION_AMOUNT_MISMATCH e nada é gravado', async () => {
  const { entries, tx } = await seed([50, 49.99], 100);
  const r = await http(tokenOk, 'POST', '/finance/reconciliations/group', { financialEntryIds: entries.map((e) => e.id), bankTransactionIds: [tx.id] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'FINANCE_RECONCILIATION_AMOUNT_MISMATCH');
  const gravadas = await withTenantTransaction(tenant, (t) => Reconciliation.count({ where: { bankTransactionId: tx.id }, transaction: t }));
  assert.equal(gravadas, 0);
});
