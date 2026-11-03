'use strict';

/**
 * BUG M45 — "VEN-2026-0001" saiu em dois contratos (SALE_CASH e SALE_TRADE).
 * Tudo em transações com ROLLBACK: nada fica no banco compartilhado.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const base = () => ({ groupId: tenant.groupId, companyId: tenant.companyId });

test('tipos com o mesmo prefixo (SALE_CASH/SALE_TRADE/SALE_FINANCED) não repetem número', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const nums = [];
    for (const contractType of ['SALE_CASH', 'SALE_TRADE', 'SALE_FINANCED', 'SALE_INSTALLMENTS']) {
      const c = await contractsService.createContract({ ...base(), contractType }, tenant.userId, transaction);
      nums.push(c.contractNumber);
    }
    assert.equal(new Set(nums).size, nums.length, `números repetidos: ${nums.join(', ')}`);
    assert.ok(nums.every((n) => /^VEN-\d{4}-\d{4,}$/.test(n)));
  });
});

test('LEASE e LEASE_RESIDENTIAL compartilham LOC sem colisão', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await contractsService.createContract({ ...base(), contractType: 'LEASE' }, tenant.userId, transaction);
    const b = await contractsService.createContract({ ...base(), contractType: 'LEASE_RESIDENTIAL' }, tenant.userId, transaction);
    assert.notEqual(a.contractNumber, b.contractNumber);
  });
});

test('número explícito já usado na empresa é recusado com 409 (índice único)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const a = await contractsService.createContract({ ...base(), contractType: 'SALE_CASH' }, tenant.userId, transaction);
    await assert.rejects(
      contractsService.createContract({ ...base(), contractType: 'SALE_TRADE', contractNumber: a.contractNumber }, tenant.userId, transaction),
      (err) => err.statusCode === 409 && err.code === 'LEGAL_CONTRACT_NUMBER_DUPLICATE'
    );
  });
});

test('concorrência: segunda geração espera o lock da primeira (nunca lê o mesmo last_seq)', async () => {
  const t1 = await sequelize.transaction();
  const t2 = await sequelize.transaction();
  for (const t of [t1, t2]) {
    await sequelize.query('SET LOCAL app.group_id = :g', { replacements: { g: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: tenant.companyId }, transaction: t });
  }
  try {
    const n1 = await contractsService.generateContractNumber(tenant.companyId, 'SALE_CASH', t1);
    let settled = false;
    const p2 = contractsService.generateContractNumber(tenant.companyId, 'SALE_TRADE', t2).then((n) => { settled = true; return n; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, 'T2 deveria estar bloqueada pelo lock de linha do prefixo VEN');
    // Simula o commit de T1 sem persistir: fazemos T1 avançar mais uma vez e só então soltamos.
    const n1b = await contractsService.generateContractNumber(tenant.companyId, 'SALE_FINANCED', t1);
    assert.notEqual(n1, n1b);
    await t1.rollback();
    const n2 = await p2;
    assert.match(n2, /^VEN-/);
  } finally {
    await t1.rollback().catch(() => {});
    await t2.rollback().catch(() => {});
  }
});
