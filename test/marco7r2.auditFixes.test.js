'use strict';

/**
 * Auditoria Marco 7 "r2" (Claude Browser, 17/10/2026) — 3 achados reais corrigidos, cada um
 * provado aqui contra Postgres real (RLS via SET LOCAL, mesmo caminho do runtime):
 *
 *  1. Usuário suspenso/inativo aparecia no dropdown de responsável de Patrimônio (empréstimo/
 *     transferência). O front agora filtra status ACTIVE nas opções de seleção; o contrato de
 *     API que ele usa (`GET /users?status=ACTIVE`) é provado aqui — e a listagem administrativa
 *     SEM filtro continua devolvendo o usuário inativo (gestão precisa enxergá-lo).
 *  2. Baixa de parcela de seguro aceitava QUALQUER lançamento SETTLED de valor igual — inclusive
 *     um RECEBIMENTO de aluguel (nature RECEIVABLE) de outro contrato. Prêmio é despesa:
 *     o backend agora rejeita nature != PAYABLE (INSURANCE_INSTALLMENT_ENTRY_WRONG_NATURE),
 *     mesmo em chamada direta à API com id forçado (defesa em profundidade, não só filtro de UI).
 *  3. Lista de Requisições de material não mostrava quem pediu — o backend agora inclui
 *     `requestedByUser` (id/nome) na listagem, mesmo padrão de `movedByUser` em Movimentos.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sequelize,
  getSeedTenant,
  withRollbackTenantTransaction,
  uniqueSuffix,
  createTestResultCenter,
} = require('./testHelpers');
const { User } = require('../src/models');
const usersService = require('../src/features/users/users.service');
const insuranceService = require('../src/features/procurement/insurance.service');
const requisitionsService = require('../src/features/inventory/requisitions.service');
const itemsService = require('../src/features/inventory/items.service');
const { createFinancialEntry, settleFinancialEntry } = require('../src/features/finance/financialEntries.service');

let tenant;

test.before(async () => {
  tenant = await getSeedTenant();
});

test.after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

// ---------------------------------------------------------------------------------------------
// Achado 1 — usuário suspenso fora da seleção de responsável, mas visível na administração
// ---------------------------------------------------------------------------------------------

test('R2-1: usuário SUSPENDED não entra na listagem de seleção (status=ACTIVE), mas segue na administrativa', async () => {
  const suffix = uniqueSuffix();
  // core.users é global (sem RLS) e listUsers não participa de transação — cria direto,
  // mesmo padrão dos usuários "HOMO QA" de testHelpers.approveFinancialEntryForSettlement.
  const [suspended] = await User.findOrCreate({
    where: { email: `homo-qa-suspenso-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Suspenso ${suffix}`, passwordHash: 'x', status: 'SUSPENDED' },
  });
  const [active] = await User.findOrCreate({
    where: { email: `homo-qa-ativo-${suffix}@nayaraone.dev` },
    defaults: { name: `HOMO QA — Ativo ${suffix}`, passwordHash: 'x', status: 'ACTIVE' },
  });

  const selectable = await usersService.listUsers({ status: 'ACTIVE' });
  assert.ok(
    !selectable.some((u) => u.id === suspended.id),
    'usuário SUSPENDED não pode aparecer na listagem usada pela seleção de responsável/custódia'
  );
  assert.ok(
    selectable.some((u) => u.id === active.id),
    'usuário ACTIVE precisa continuar aparecendo na seleção'
  );

  const administrative = await usersService.listUsers({});
  assert.ok(
    administrative.some((u) => u.id === suspended.id),
    'a listagem administrativa (sem filtro) precisa continuar mostrando o usuário suspenso'
  );
});

// ---------------------------------------------------------------------------------------------
// Achado 2 — baixa de parcela de seguro rejeita lançamento de outro domínio (RECEIVABLE)
// ---------------------------------------------------------------------------------------------

test('R2-2: baixa de parcela de prêmio rejeita RECEBIMENTO (RECEIVABLE) de valor igual — e aceita PAYABLE', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const policy = await insuranceService.createPolicy(withTenant({}), tenant.userId, transaction);
    await insuranceService.quotePolicy(policy.id, { estimatedValue: 10000 }, withTenant({ userId: tenant.userId }), transaction);
    const issued = await insuranceService.issuePolicy(
      policy.id,
      { effectiveDate: '2026-10-05', expiryDate: '2027-10-05', installmentsCount: 2 },
      withTenant({ userId: tenant.userId }),
      transaction
    );
    const [firstInstallment] = await insuranceService.listPolicyInstallments(issued.id, tenant.groupId, tenant.companyId, transaction);
    assert.ok(firstInstallment, 'emissão precisa ter gerado parcelas');

    // "Recebimento de aluguel" simulado: CREDIT/RECEIVABLE liquidado com o MESMO valor da
    // parcela — exatamente o cenário do achado (valor igual bastava para aparecer e passar).
    const resultCenter = await createTestResultCenter(tenant, transaction);
    const rentReceipt = await createFinancialEntry(
      withTenant({
        entryType: 'CREDIT',
        nature: 'RECEIVABLE',
        amount: Number(firstInstallment.amount),
        description: `HOMO QA r2 — recebimento de aluguel ${uniqueSuffix()}`,
        resultCenterId: resultCenter.id,
      }),
      tenant.userId,
      transaction
    );
    await settleFinancialEntry(rentReceipt.id, tenant.userId, transaction);

    // ATUALIZADO (auditoria Marco 7 Compras E2E, 2026-10-18): a regra ficou ainda mais forte —
    // a parcela nasce com o PRÓPRIO payable vinculado, e QUALQUER outro lançamento (inclusive o
    // recebimento de aluguel deste cenário) é rejeitado como NOT_LINKED antes mesmo da checagem
    // de natureza. O achado original (aluguel quitando prêmio) continua provadamente bloqueado.
    await assert.rejects(
      () => insuranceService.payInsurancePolicyInstallment(firstInstallment.id, rentReceipt.id, withTenant({ userId: tenant.userId }), transaction),
      (err) => {
        assert.equal(err.code, 'INSURANCE_INSTALLMENT_ENTRY_NOT_LINKED');
        return true;
      },
      'um recebimento nunca pode quitar parcela de prêmio, mesmo com valor idêntico e id forçado via API'
    );

    // Caminho legítimo: liquidar o payable VINCULADO da parcela e dar baixa com ele.
    const { settleFinancialEntryWithApproval } = require('./testHelpers');
    await settleFinancialEntryWithApproval(tenant, firstInstallment.financialEntryId, tenant.userId, transaction);
    const paid = await insuranceService.payInsurancePolicyInstallment(
      firstInstallment.id,
      firstInstallment.financialEntryId,
      withTenant({ userId: tenant.userId }),
      transaction
    );
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.financialEntryId, firstInstallment.financialEntryId);
  });
});

// ---------------------------------------------------------------------------------------------
// Achado 3 — listagem de requisições de material inclui o nome do solicitante
// ---------------------------------------------------------------------------------------------

test('R2-3: listRequisitions devolve requestedByUser com o nome do solicitante', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const warehouse = await itemsService.createLocation(
      withTenant({ name: `HOMO QA r2 Almoxarifado ${suffix}`, locationType: 'WAREHOUSE' }),
      tenant.userId,
      transaction
    );
    const item = await itemsService.createItem(
      withTenant({ name: `HOMO QA r2 Item ${suffix}`, sku: `HQR2-${suffix}`, unitOfMeasure: 'UN' }),
      tenant.userId,
      transaction
    );
    const requisition = await requisitionsService.createRequisition(
      withTenant({ warehouseLocationId: warehouse.id, items: [{ inventoryItemId: item.id, quantity: 2 }] }),
      tenant.userId,
      transaction
    );

    const listed = await requisitionsService.listRequisitions(tenant.groupId, tenant.companyId, transaction, {});
    const row = listed.find((r) => r.id === requisition.id);
    assert.ok(row, 'a requisição recém-criada precisa aparecer na listagem');
    assert.ok(row.requestedByUser, 'a listagem precisa incluir o solicitante (requestedByUser)');
    assert.equal(row.requestedByUser.id, tenant.userId);
    assert.ok(row.requestedByUser.name, 'o NOME do solicitante precisa vir preenchido — era só o UUID antes');
  });
});
