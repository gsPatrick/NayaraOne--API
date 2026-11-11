'use strict';

// Marco 4 — Guia §10 "Importação bancária idempotente: UNIQUE(bank_account_id, fingerprint)" sem condição (o índice era parcial, só linhas com id
// externo: sonda V2-P4 do verificador gravou a mesma linha duas vezes) e FIN-002 (pentest do Marco 4: B gravava linha de extrato na conta bancária de A).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PORT = process.env.M4CC_EXTRATO_HTTP_TEST_PORT || process.env.M4_EXTRATO_TEST_PORT || '21618';
require('../app');
const { sequelize, getSeedTenant, withRollbackTenantTransaction, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const { tokenFor, client, isolatedTenant, closeIsolated } = require('./helpers/m4FinanceHttp');
const bankAccounts = require('../src/modules/finance/application/services/bank-accounts.service');
const bankTx = require('../src/modules/finance/application/services/bank-transactions.service');
const { mapFinanceUniqueViolation } = require('../src/modules/finance/presentation/http/finance-unique-violations');

let tenant;
let http;
before(async () => {
  tenant = await getSeedTenant();
  http = client(`http://127.0.0.1:${process.env.PORT}/api/v1`);
  await new Promise((r) => setTimeout(r, 300));
});
after(async () => {
  await closeIsolated();
  await sequelize.close();
  process.exit(0);
});

const newAccount = (ctx, t, s) => bankAccounts.createBankAccount({ groupId: ctx.groupId, companyId: ctx.companyId, bankCode: '341', agency: '0001', accountNumber: `FP-${s}` }, ctx.userId, t);

test('V2-P4 (sonda do verificador, aceite): a mesma linha de extrato sem id externo não entra duas vezes e o índice é UNIQUE(bank_account_id, fingerprint) sem condição', async () => {
  const s = uniqueSuffix();
  const out = {};
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await newAccount(tenant, t, s);
    const line = { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: acc.id, amount: 123.45, transactionDate: new Date('2026-11-05T15:00:00Z'), description: 'PIX RECEBIDO FULANO' };
    await bankTx.createBankTransaction({ ...line }, tenant.userId, t);
    try { await bankTx.createBankTransaction({ ...line }, tenant.userId, t); out.second = 'aceita'; } catch (e) { out.second = e.code || e.message; }
    const [rows] = await sequelize.query('SELECT count(*)::int AS n FROM finance.bank_transactions WHERE bank_account_id = :id', { replacements: { id: acc.id }, transaction: t });
    out.linhasNaConta = rows[0].n;
    const [idx] = await sequelize.query("SELECT indexdef FROM pg_indexes WHERE schemaname='finance' AND indexname='bank_transactions_account_fingerprint_uk'", { transaction: t });
    out.indice = idx[0] && idx[0].indexdef;
  });
  assert.equal(out.second, 'FINANCE_BANK_TRANSACTION_DUPLICATE', JSON.stringify(out));
  assert.equal(out.linhasNaConta, 1);
  assert.match(out.indice, /UNIQUE INDEX bank_transactions_account_fingerprint_uk ON finance\.bank_transactions USING btree \(bank_account_id, fingerprint\)$/);
  assert.doesNotMatch(out.indice, /WHERE/);
});

test('M4-G§10 o índice segura a corrida: INSERT direto (sem a checagem do serviço) com o mesmo fingerprint é barrado e vira 409 do Financeiro', async () => {
  const s = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await newAccount(tenant, t, s);
    const insert = () => sequelize.query(
      `INSERT INTO finance.bank_transactions (id, group_id, company_id, bank_account_id, amount, transaction_date, description, created_at, updated_at)
       VALUES (gen_random_uuid(), :g, :c, :a, -77.10, '2026-11-06T15:00:00Z', 'TARIFA', now(), now())`,
      { replacements: { g: tenant.groupId, c: tenant.companyId, a: acc.id }, transaction: t }
    );
    await insert();
    let err;
    await sequelize.query('SAVEPOINT fp_dup', { transaction: t });
    try { await insert(); } catch (e) { err = e; }
    await sequelize.query('ROLLBACK TO SAVEPOINT fp_dup', { transaction: t });
    assert.ok(err, 'o banco recusou a segunda linha');
    assert.equal(err.name, 'SequelizeUniqueConstraintError');
    assert.deepEqual(mapFinanceUniqueViolation(err), { statusCode: 409, code: 'FINANCE_BANK_TRANSACTION_DUPLICATE', message: 'Esta mesma linha de extrato (conta, data, valor, sentido e descrição) já foi registrada — duplicidade bloqueada.' });
  });
});

test('M4-G§10 linhas diferentes continuam entrando: outro dia, outro valor, outra descrição ou outro id externo', async () => {
  const s = uniqueSuffix();
  await withRollbackTenantTransaction(tenant, async (t) => {
    const acc = await newAccount(tenant, t, s);
    const base = { groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId: acc.id, amount: 10, transactionDate: '2026-11-03', description: 'PIX' };
    for (const v of [{}, { transactionDate: '2026-11-04' }, { amount: 10.01 }, { description: 'PIX 2' }, { externalTransactionId: `E-${s}` }, { amount: -10 }]) {
      await bankTx.createBankTransaction({ ...base, ...v }, tenant.userId, t);
    }
    const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM finance.bank_transactions WHERE bank_account_id = :id', { replacements: { id: acc.id }, transaction: t });
    assert.equal(n, 6);
  });
});

test('FIN-002 (pentest M4, achado crítico): empresa B não grava linha de extrato na conta bancária da empresa A (404, nada gravado, sem oráculo de duplicidade)', async () => {
  const a = await isolatedTenant('fp-A');
  const b = await isolatedTenant('fp-B');
  const accA = await withTenantTransaction(a, (t) => newAccount(a, t, `A-${uniqueSuffix()}`));
  const line = { bankAccountId: accA.id, amount: -55.5, transactionDate: '2026-11-07', description: 'TARIFA' };
  const own = await http('POST', '/finance/bank-transactions', tokenFor(a, a.userId), line);
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const cross = await http('POST', '/finance/bank-transactions', tokenFor(b, b.userId), line);
  assert.equal(cross.status, 404, JSON.stringify(cross.body));
  assert.equal(cross.code, 'FINANCE_BANK_ACCOUNT_NOT_FOUND', 'a mesma resposta de conta inexistente: não revela a linha de A');
  const listaB = await http('GET', '/finance/bank-transactions', tokenFor(b, b.userId));
  assert.equal(listaB.status, 200);
  assert.ok(!listaB.body.data.some((r) => r.bankAccountId === accA.id), 'nada gravado na empresa B com a conta de A');
});
