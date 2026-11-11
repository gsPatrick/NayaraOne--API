'use strict';

// Caderno do Marco 4, §3 "Estrutura empresarial financeira" (fechamento da matriz, 10/11/2026):
//   Locação               | Sicredi                | Aluguéis, repasses, garantias, despesas locatícias.
//   Construção            | Banco do Brasil        | Obras, fornecedores, materiais, pós-obra, recebimentos de venda/obra.
//   NC Serviços Bancários | Conta(s) própria(s)    | Comissões de correspondente e comissões vinculadas aos corretores.
//   Consolidado Diretoria | Somente visão          | Não mistura ledger nem saldos; agrega relatórios.
// No Nayara One cada operação é uma EMPRESA do grupo (company_id próprio, RLS FORCE). Estes testes
// provam o §3 linha a linha: cada operação tem a sua conta, uma operação não lança na conta da
// outra (§15 "Nunca registrar uma despesa da empresa A diretamente na conta da B") e a conta do
// NC Serviços fica vinculada ao corretor dono dela (owner_person_id).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestCostCenter, createTestResultCenter } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const { Company, Person } = require('../src/models');

let tenant;
before(async () => {
  tenant = await getSeedTenant();
});
after(async () => {
  await sequelize.close();
});

async function setCompany(transaction, companyId) {
  await sequelize.query('SET LOCAL app.company_id = :c', { replacements: { c: companyId }, transaction });
}

async function codeOf(fn) {
  try {
    await fn();
    return 'sem erro';
  } catch (err) {
    return err.code || err.name;
  }
}

// Cria, no mesmo grupo do seed, as empresas da operação e devolve um contexto por empresa.
async function montarOperacoes(t) {
  const sfx = uniqueSuffix();
  const construcao = await Company.create({ groupId: tenant.groupId, name: `Construção ${sfx}`, status: 'ACTIVE' }, { transaction: t });
  const ncServicos = await Company.create({ groupId: tenant.groupId, name: `NC Serviços Bancários ${sfx}`, status: 'ACTIVE' }, { transaction: t });
  const locacao = { id: tenant.companyId };
  const conta = (companyId, bankCode, extra = {}) => bankAccountsService.createBankAccount(
    { groupId: tenant.groupId, companyId, bankCode, agency: '0001', accountNumber: `${bankCode}-${sfx}`, ...extra },
    tenant.userId,
    t
  );
  await setCompany(t, locacao.id);
  const sicredi = await conta(locacao.id, '748');
  await setCompany(t, construcao.id);
  const bancoDoBrasil = await conta(construcao.id, '001');
  return { sfx, locacao, construcao, ncServicos, sicredi, bancoDoBrasil, conta };
}

test('M4-§3 Locação (Sicredi) e Construção (Banco do Brasil): cada operação vê e usa só a própria conta', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const op = await montarOperacoes(t);

    await setCompany(t, op.locacao.id);
    const contasLocacao = (await bankAccountsService.listBankAccounts(t)).map((c) => c.id);
    assert.ok(contasLocacao.includes(op.sicredi.id), 'a Locação enxerga a própria conta Sicredi');
    assert.ok(!contasLocacao.includes(op.bancoDoBrasil.id), 'a Locação NÃO enxerga a conta Banco do Brasil da Construção');

    await setCompany(t, op.construcao.id);
    const contasConstrucao = (await bankAccountsService.listBankAccounts(t)).map((c) => c.id);
    assert.ok(contasConstrucao.includes(op.bancoDoBrasil.id), 'a Construção enxerga a própria conta Banco do Brasil');
    assert.ok(!contasConstrucao.includes(op.sicredi.id), 'a Construção NÃO enxerga a conta Sicredi da Locação');
    assert.equal(op.sicredi.bankCode, '748');
    assert.equal(op.bancoDoBrasil.bankCode, '001');
  });
});

test('M4-§3/§15 despesa de obra da Construção na conta Sicredi da Locação é recusada; na conta Banco do Brasil da própria Construção é aceita', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const op = await montarOperacoes(t);
    await setCompany(t, op.construcao.id);
    const ctx = { ...tenant, companyId: op.construcao.id };
    const centro = await createTestCostCenter(ctx, t);
    const despesa = (bankAccountId, chave) => financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId, companyId: op.construcao.id, nature: 'PAYABLE', entryType: 'DEBIT', amount: 8000,
        description: `Material de obra ${op.sfx}`, costCenterId: centro.id, bankAccountId, idempotencyKey: `m4-s3-${chave}-${op.sfx}`,
      },
      tenant.userId,
      t
    );
    const recusa = await codeOf(() => sequelize.transaction({ transaction: t }, () => despesa(op.sicredi.id, 'sicredi')));
    assert.equal(recusa, 'FINANCE_BANK_ACCOUNT_NOT_FOUND', 'a conta Sicredi da Locação é invisível para a Construção (RLS) e a despesa é recusada');
    const [[{ n }]] = await sequelize.query(
      "SELECT count(*)::int AS n FROM finance.financial_entries WHERE idempotency_key = :k",
      { replacements: { k: `m4-s3-sicredi-${op.sfx}` }, transaction: t }
    );
    assert.equal(n, 0, 'nada foi gravado na tentativa recusada');

    const aceita = await despesa(op.bancoDoBrasil.id, 'bb');
    assert.equal(aceita.companyId, op.construcao.id);
    assert.equal(aceita.bankAccountId, op.bancoDoBrasil.id);
  });
});

test('M4-§3 Locação recebe aluguel na própria conta Sicredi, com centro de resultado (receita da operação de Locação)', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const op = await montarOperacoes(t);
    await setCompany(t, op.locacao.id);
    const centro = await createTestResultCenter(tenant, t);
    const aluguel = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId, companyId: op.locacao.id, nature: 'RECEIVABLE', entryType: 'CREDIT', amount: 2500,
        description: `Aluguel ${op.sfx}`, resultCenterId: centro.id, bankAccountId: op.sicredi.id, idempotencyKey: `m4-s3-aluguel-${op.sfx}`,
      },
      tenant.userId,
      t
    );
    assert.equal(aluguel.bankAccountId, op.sicredi.id);
    assert.equal(aluguel.companyId, op.locacao.id);
    assert.equal(String(aluguel.amount), '2500.00');
  });
});

test('M4-§3 NC Serviços Bancários: conta própria vinculada ao corretor (owner_person_id), invisível para as outras operações', async () => {
  await withRollbackTenantTransaction(tenant, async (t) => {
    const op = await montarOperacoes(t);
    await setCompany(t, op.ncServicos.id);
    const corretor = await Person.create(
      { groupId: tenant.groupId, companyId: op.ncServicos.id, personType: 'PF', legalName: `Corretor ${op.sfx}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction: t }
    );
    const contaCorretor = await op.conta(op.ncServicos.id, '237', { ownerPersonId: corretor.id });
    assert.equal(contaCorretor.ownerPersonId, corretor.id, 'a conta do NC Serviços fica vinculada ao corretor');
    const doCorretor = await bankAccountsService.listBankAccounts(t, { ownerPersonId: corretor.id });
    assert.deepEqual(doCorretor.map((c) => c.id), [contaCorretor.id], 'filtro por corretor devolve só a conta dele');

    await setCompany(t, op.locacao.id);
    const daLocacao = (await bankAccountsService.listBankAccounts(t)).map((c) => c.id);
    assert.ok(!daLocacao.includes(contaCorretor.id), 'a Locação não enxerga a conta do corretor do NC Serviços');
    await setCompany(t, op.construcao.id);
    const daConstrucao = (await bankAccountsService.listBankAccounts(t)).map((c) => c.id);
    assert.ok(!daConstrucao.includes(contaCorretor.id), 'a Construção não enxerga a conta do corretor do NC Serviços');
  });
});
