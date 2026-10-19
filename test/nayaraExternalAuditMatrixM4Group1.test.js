'use strict';

// Auditoria externa Nayara, 15/10/2026, "Conferência complementar Marcos 4 e 5", Seção 4 —
// Matriz de cobertura do restante do caderno, Marco 4 — Financeiro. Este arquivo fecha com
// prova E2E real (Postgres, RLS ativo) os grupos:
//   - Repasses e composição (§12): "dois repasses não reutilizam o mesmo saldo", extrato do
//     proprietário, teto por recebimentos reais, abatimentos documentados.
//   - Caução/terceiros (§13/FIN-TS-005/015): receber/devolver e separação do caixa livre.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix, createTestResultCenter, createTestCostCenter, settleFinancialEntryWithApproval } = require('./testHelpers');
const financialEntriesService = require('../src/features/finance/financialEntries.service');
const bankAccountsService = require('../src/features/finance/bankAccounts.service');
const ownerRepassesService = require('../src/features/finance/ownerRepasses.service');
const propertiesService = require('../src/features/properties/properties.service');
const { Person, Contract, ContractParty } = require('../src/models');

async function createTestContract(tenant, transaction, suffix) {
  return Contract.create(
    {
      groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE',
      contractNumber: `CAUCAO-TST-${suffix}`, status: 'ACTIVE', createdBy: tenant.userId, updatedBy: tenant.userId,
    },
    { transaction }
  );
}

// F04 (conferência Nayara 18/10/2026): caução tem titular, e o titular precisa ser parte do contrato.
async function createTenantParty(tenant, transaction, contract, suffix) {
  const holder = await Person.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Caução titular ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
    { transaction }
  );
  await ContractParty.create(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, personId: holder.id, partyRole: 'TENANT' },
    { transaction }
  );
  return holder;
}

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

// --- GAP REAL (achado desta rodada, auditoria 15/10/2026): dois repasses não reutilizam o mesmo saldo ---
test('Repasses §12: GAP CORRIGIDO — um segundo repasse NÃO pode reutilizar o saldo já consumido pelo primeiro repasse sobre o mesmo recebimento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const owner = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Repasse-dup Proprietário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, ownerPersonId: owner.id, bankCode: '001', accountNumber: `RPDUP-${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Repasse-dup Imóvel ${suffix}`, internalCode: `RPDUPP-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const recebimento = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: `Repasse-dup aluguel ${suffix}`, resultCenterId: resultCenter.id },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(recebimento.id, tenant.userId, transaction);

    // Primeiro repasse consome o valor CHEIO do recebimento (1000).
    const repasse1 = await ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id,
        bankAccountId: account.id, sourceEntryIds: [recebimento.id], grossAmount: 1000, referenceMonth: '2026-09',
      },
      tenant.userId, transaction
    );
    assert.equal(Number(repasse1.netAmount), 1000);

    // Segundo repasse tentando usar o MESMO recebimento (saldo já zerado) deve ser BLOQUEADO —
    // antes do fix, isso passava livremente e "repassava" 1000 de novo do mesmo dinheiro.
    await assert.rejects(
      () =>
        ownerRepassesService.createOwnerRepasse(
          {
            groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id,
            bankAccountId: account.id, sourceEntryIds: [recebimento.id], grossAmount: 1000, referenceMonth: '2026-10',
          },
          tenant.userId, transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP'); return true; },
      'segundo repasse não pode reutilizar o saldo já consumido pelo primeiro — teto elegível deve estar zerado'
    );
  });
});

test('Repasses §12: GAP CORRIGIDO — repasse parcial consome só a fração usada, deixando o restante disponível para um segundo repasse legítimo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const owner = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Repasse-parcial Proprietário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, ownerPersonId: owner.id, bankCode: '001', accountNumber: `RPPAR-${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Repasse-parcial Imóvel ${suffix}`, internalCode: `RPPARP-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const recebimento = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: `Repasse-parcial aluguel ${suffix}`, resultCenterId: resultCenter.id },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(recebimento.id, tenant.userId, transaction);

    // Repasse 1 usa só 400 dos 1000 elegíveis (ex.: repasse antecipado parcial).
    const repasse1 = await ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id,
        bankAccountId: account.id, sourceEntryIds: [recebimento.id], grossAmount: 400, referenceMonth: '2026-09',
      },
      tenant.userId, transaction
    );
    assert.equal(Number(repasse1.netAmount), 400);

    // Repasse 2 pode usar o restante legítimo (600) do mesmo recebimento.
    const repasse2 = await ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id,
        bankAccountId: account.id, sourceEntryIds: [recebimento.id], grossAmount: 600, referenceMonth: '2026-10', // Frente 3: um repasse por período
      },
      tenant.userId, transaction
    );
    assert.equal(Number(repasse2.netAmount), 600);

    // Um terceiro repasse de 1 centavo a mais já deve estourar o teto (saldo zerado).
    await assert.rejects(
      () =>
        ownerRepassesService.createOwnerRepasse(
          {
            groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id,
            bankAccountId: account.id, sourceEntryIds: [recebimento.id], grossAmount: 0.01, referenceMonth: '2026-11',
          },
          tenant.userId, transaction
        ),
      (err) => { assert.equal(err.code, 'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP'); return true; },
      'saldo do recebimento deve estar totalmente consumido após 400 + 600 = 1000'
    );

    // Extrato do proprietário: cada repasse mostra sua própria composição, não o valor cheio do lançamento.
    const composicao1 = await ownerRepassesService.getOwnerRepasseComposition(repasse1.id, transaction);
    const composicao2 = await ownerRepassesService.getOwnerRepasseComposition(repasse2.id, transaction);
    assert.equal(composicao1.composition[0].eligibleAmount, 400);
    assert.equal(composicao2.composition[0].eligibleAmount, 600);
  });
});

test('Repasses §12: um repasse CANCELLED devolve o saldo do recebimento para um novo repasse legítimo', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const owner = await Person.create(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Repasse-cancel Proprietário ${suffix}`, createdBy: tenant.userId, updatedBy: tenant.userId },
      { transaction }
    );
    const account = await bankAccountsService.createBankAccount(
      { groupId: tenant.groupId, companyId: tenant.companyId, ownerPersonId: owner.id, bankCode: '001', accountNumber: `RPCAN-${suffix}` },
      tenant.userId,
      transaction
    );
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `Repasse-cancel Imóvel ${suffix}`, internalCode: `RPCANP-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const recebimento = await financialEntriesService.createFinancialEntry(
      { groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE', amount: 1000, description: `Repasse-cancel aluguel ${suffix}`, resultCenterId: resultCenter.id },
      tenant.userId,
      transaction
    );
    await financialEntriesService.settleFinancialEntry(recebimento.id, tenant.userId, transaction);

    const repasse1 = await ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id,
        bankAccountId: account.id, sourceEntryIds: [recebimento.id], grossAmount: 1000, referenceMonth: '2026-09',
      },
      tenant.userId, transaction
    );

    // Cancela o primeiro repasse diretamente no modelo (não há endpoint de cancelamento de
    // repasse no serviço ainda — só testamos que, SE o status mudar para CANCELLED por algum
    // caminho futuro, o saldo volta a ficar disponível, confirmando que o cálculo não está
    // hardcoded a ignorar status).
    const { OwnerRepass } = require('../src/models');
    const persisted = await OwnerRepass.findByPk(repasse1.id, { transaction });
    persisted.status = 'CANCELLED';
    await persisted.save({ transaction });

    const repasse2 = await ownerRepassesService.createOwnerRepasse(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, propertyId: property.id, ownerPersonId: owner.id,
        bankAccountId: account.id, sourceEntryIds: [recebimento.id], grossAmount: 1000, referenceMonth: '2026-10',
      },
      tenant.userId, transaction
    );
    assert.equal(Number(repasse2.netAmount), 1000, 'repasse cancelado deve liberar o saldo de volta');
  });
});

// --- Caução/terceiros §13: receber, devolver e separação do caixa livre ---
test('Caução §13: receber caução vinculada ao contrato, excluída do caixa livre, e devolver com referência rastreável ao mesmo contrato', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const costCenter = await createTestCostCenter(tenant, transaction);
    const contract = await createTestContract(tenant, transaction, suffix);
    const fakeContractId = contract.id;
    const holder = await createTenantParty(tenant, transaction, contract, suffix);

    // RECEBER: caução entra como RECEIVABLE isThirdPartyFunds=true, vinculada ao contrato e ao titular.
    const caucaoRecebida = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE',
        amount: 2000, description: `Caução §13 recebida ${suffix}`, resultCenterId: resultCenter.id,
        contractId: fakeContractId, isThirdPartyFunds: true, thirdPartyReference: `Caução contrato ${fakeContractId}`,
        thirdPartyHolderPersonId: holder.id,
      },
      tenant.userId, transaction
    );
    await financialEntriesService.settleFinancialEntry(caucaoRecebida.id, tenant.userId, transaction);

    // DEVOLVER: caução sai como PAYABLE isThirdPartyFunds=true, mesma referência/contrato —
    // nunca classificada como despesa própria (senão poluiria o resultado da empresa com um
    // valor que nunca foi receita dela).
    const caucaoDevolvida = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE',
        amount: 2000, description: `Caução §13 devolvida ${suffix}`, costCenterId: costCenter.id,
        contractId: fakeContractId, isThirdPartyFunds: true, thirdPartyReference: `Caução contrato ${fakeContractId}`,
        thirdPartyOriginEntryId: caucaoRecebida.id,
      },
      tenant.userId, transaction
    );
    // Revisão 18/10/2026 (A1): devolução é saída de caixa — aprovação + comprovante (ou banco).
    await settleFinancialEntryWithApproval(tenant, caucaoDevolvida.id, tenant.userId, transaction);

    // EXTRATO do contrato: os dois lançamentos (receber + devolver) aparecem juntos, e AMBOS
    // seguem marcados como dinheiro de terceiro — nunca somados à receita/despesa própria.
    const { FinancialEntry } = require('../src/models');
    const extrato = await FinancialEntry.findAll({ where: { contractId: fakeContractId }, order: [['created_at', 'ASC']], transaction });
    assert.equal(extrato.length, 2, 'extrato do contrato deve mostrar receber + devolver da caução');
    assert.ok(extrato.every((e) => e.isThirdPartyFunds === true), 'todo lançamento de caução permanece marcado como dinheiro de terceiro');
    assert.ok(extrato.every((e) => e.thirdPartyReference && e.thirdPartyReference.includes(fakeContractId)), 'referência rastreável ao mesmo contrato em ambos os lados');

    // SEPARAÇÃO DO CAIXA LIVRE: somar só receita própria (isThirdPartyFunds=false) do resultCenter
    // usado não deve incluir a caução recebida.
    const receitaPropria = await FinancialEntry.findAll({
      where: { resultCenterId: resultCenter.id, nature: 'RECEIVABLE', isThirdPartyFunds: false },
      transaction,
    });
    assert.ok(
      !receitaPropria.some((e) => e.id === caucaoRecebida.id),
      'caução recebida NUNCA pode aparecer somada como receita própria da empresa'
    );
  });
});

// F04 (conferência Nayara 18/10/2026): este teste documentava o gap ("devolução solta é aceita").
// O vínculo agora é exigido — a mesma devolução sem origem, ou apontando outro contrato, é recusada.
test('Caução §13: devolução sem vínculo com a caução recebida, ou com contrato diferente, é recusada', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const costCenter = await createTestCostCenter(tenant, transaction);
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const contrato = await createTestContract(tenant, transaction, suffix);
    const holder = await createTenantParty(tenant, transaction, contrato, suffix);
    const outroContrato = await createTestContract(tenant, transaction, `${suffix}b`);

    await assert.rejects(
      () => financialEntriesService.createFinancialEntry(
        {
          groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE',
          amount: 500, description: `Caução devolução solta ${suffix}`, costCenterId: costCenter.id,
          contractId: outroContrato.id, isThirdPartyFunds: true, thirdPartyReference: `Caução sem vínculo real ${suffix}`,
        },
        tenant.userId, transaction
      ),
      (err) => { assert.equal(err.code, 'FINANCE_THIRD_PARTY_ORIGIN_REQUIRED'); return true; }
    );

    const recebida = await financialEntriesService.createFinancialEntry(
      {
        groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'CREDIT', nature: 'RECEIVABLE',
        amount: 500, description: `Caução recebida ${suffix}`, resultCenterId: resultCenter.id,
        contractId: contrato.id, isThirdPartyFunds: true, thirdPartyReference: `Caução contrato ${contrato.id}`,
        thirdPartyHolderPersonId: holder.id,
      },
      tenant.userId, transaction
    );
    await financialEntriesService.settleFinancialEntry(recebida.id, tenant.userId, transaction);
    await assert.rejects(
      () => financialEntriesService.createFinancialEntry(
        {
          groupId: tenant.groupId, companyId: tenant.companyId, entryType: 'DEBIT', nature: 'PAYABLE',
          amount: 500, description: `Caução devolvida no contrato errado ${suffix}`, costCenterId: costCenter.id,
          contractId: outroContrato.id, isThirdPartyFunds: true, thirdPartyReference: `Caução contrato ${outroContrato.id}`,
          thirdPartyOriginEntryId: recebida.id,
        },
        tenant.userId, transaction
      ),
      (err) => { assert.equal(err.code, 'FINANCE_THIRD_PARTY_CONTRACT_MISMATCH'); return true; }
    );
  });
});
