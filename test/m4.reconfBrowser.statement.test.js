'use strict';

// Conferência ao vivo do Marco 4 (20/10/2026): extrato bancário.
//  A1  — valor "abc" gravava NaN e "1.234,56" virava 1,23; agora o lote inteiro é recusado.
//  F-09 — data de dia (2026-10-20) aparecia como 19/10.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const bankTransactionsService = require('../src/features/finance/bankTransactions.service');
const { BankTransaction } = require('../src/models');
const { businessDateKey } = require('../src/utils/businessDate');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const HEADER = 'externalTransactionId,transactionDate,description,amount';
async function account(t, sfx) {
  return bankAccountsService.createBankAccount({ groupId: tenant.groupId, companyId: tenant.companyId, bankCode: '001', agency: '0001', accountNumber: `stm-${sfx}` }, tenant.userId, t);
}
async function importCsv(t, bankAccountId, csvText) {
  return bankTransactionsService.importBankStatement({ groupId: tenant.groupId, companyId: tenant.companyId, bankAccountId, csvText }, tenant.userId, t);
}
async function rejects(promise, code) {
  await assert.rejects(promise, (e) => e.statusCode === 400 && e.code === code, `esperava 400 ${code}`);
}

test('A1: valor "abc" recusa o lote inteiro com o número da linha e não grava nenhuma linha', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const ba = await account(t, sfx);
    const csv = `${HEADER}\nS-${sfx}-1,2026-10-05,linha boa,100.00\nS-${sfx}-2,2026-10-06,linha ruim,abc`;
    await assert.rejects(importCsv(t, ba.id, csv), (e) => e.statusCode === 400 && e.code === 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_ROW' && /linha 3/.test(e.message) && /Nenhuma linha foi gravada/.test(e.message));
    assert.equal(await BankTransaction.count({ where: { bankAccountId: ba.id }, transaction: t }), 0, 'a linha boa não pode entrar sozinha');
  });
});

test('A1: NaN, Infinity, vazio e "1.234" (ambíguo) são recusados', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const ba = await account(t, sfx);
    for (const bad of ['NaN', 'Infinity', '-Infinity', '', '1.234', '12,345', '1,2,3', '1e5']) {
      await rejects(importCsv(t, ba.id, `${HEADER}\nB-${sfx}-${bad.length},2026-10-05,x,"${bad}"`), 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_ROW');
    }
    assert.equal(await BankTransaction.count({ where: { bankAccountId: ba.id }, transaction: t }), 0);
  });
});

test('A1: "1.234,56" sem aspas num CSV de vírgula é recusado (não vira 1,23); entre aspas ou com ponto e vírgula vale 1234.56', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const ba = await account(t, sfx);
    await rejects(importCsv(t, ba.id, `${HEADER}\nQ-${sfx}-0,2026-10-05,sem aspas,1.234,56`), 'FINANCE_BANK_STATEMENT_IMPORT_INVALID_ROW');
    const r1 = await importCsv(t, ba.id, `${HEADER}\nQ-${sfx}-1,2026-10-05,"com aspas, e vírgula","1.234,56"\nQ-${sfx}-2,2026-10-06,ponto decimal,-150.4`);
    assert.equal(r1.imported.length, 2);
    const r2 = await importCsv(t, ba.id, `externalTransactionId;transactionDate;description;amount\nQ-${sfx}-3;06/10/2026;ponto e vírgula;1.500,00\nQ-${sfx}-4;2026-10-07;R$ 10,5;R$ 10,5`);
    assert.equal(r2.imported.length, 2);
    const rows = await BankTransaction.findAll({ where: { bankAccountId: ba.id }, transaction: t });
    const by = Object.fromEntries(rows.map((r) => [r.externalTransactionId, r]));
    assert.equal(Number(by[`Q-${sfx}-1`].amount), 1234.56);
    assert.equal(by[`Q-${sfx}-1`].description, 'com aspas, e vírgula');
    assert.equal(Number(by[`Q-${sfx}-2`].amount), -150.4);
    assert.equal(Number(by[`Q-${sfx}-3`].amount), 1500);
    assert.equal(Number(by[`Q-${sfx}-4`].amount), 10.5);
    assert.ok(rows.every((r) => Number.isFinite(Number(r.amount))), 'nenhum valor NaN');
  });
});

test('A1: reimportar o mesmo arquivo continua idempotente', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const ba = await account(t, sfx);
    const csv = `${HEADER}\nI-${sfx}-1,2026-10-05,a,10.00\nI-${sfx}-2,2026-10-06,b,20.00`;
    assert.equal((await importCsv(t, ba.id, csv)).imported.length, 2);
    const again = await importCsv(t, ba.id, csv);
    assert.equal(again.imported.length, 0);
    assert.equal(again.duplicates.length, 2);
  });
});

test('A1: o banco recusa valor NaN em finance.bank_transactions (CHECK da migration 600)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const ba = await account(t, sfx);
    const r = await importCsv(t, ba.id, `${HEADER}\nN-${sfx}-1,2026-10-05,a,10.00`);
    await assert.rejects(
      sequelize.query('UPDATE finance.bank_transactions SET amount = \'NaN\' WHERE id = :id', { replacements: { id: r.imported[0].id }, transaction: t }),
      (e) => /bank_transactions_amount_not_nan|check constraint|restrição de verificação/i.test(String(e.message) + String(e.parent && e.parent.message))
    );
  });
});

test('F-09: data de dia do CSV (2026-10-20 e 20/10/2026) fica no dia 20 no fuso de São Paulo', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const sfx = uniqueSuffix();
    const ba = await account(t, sfx);
    await importCsv(t, ba.id, `${HEADER}\nD-${sfx}-1,2026-10-20,iso,5.00\nD-${sfx}-2,20/10/2026,br,6.00\nD-${sfx}-3,2026-11-01,primeiro do mês,7.00`);
    const rows = await BankTransaction.findAll({ where: { bankAccountId: ba.id }, transaction: t });
    const by = Object.fromEntries(rows.map((r) => [r.externalTransactionId, businessDateKey(r.transactionDate)]));
    assert.equal(by[`D-${sfx}-1`], '2026-10-20');
    assert.equal(by[`D-${sfx}-2`], '2026-10-20');
    assert.equal(by[`D-${sfx}-3`], '2026-11-01', 'primeiro dia do mês não pode cair no mês anterior');
  });
});
