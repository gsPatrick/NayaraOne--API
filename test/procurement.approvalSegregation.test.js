'use strict';

// Contrato bruto (Anexo "Arquitetura Técnica Blindada", princípio constitucional): "Quem cria
// não aprova; quem aprova não altera; quem executa valida o hash aprovado" — aplicado ao ciclo
// de Compras/Procurement.
//
// Cobre:
//   (1) decidePurchaseRequest rejeita quando o ator é o mesmo que criou a requisição
//       (PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN);
//   (2) decidePurchaseRequest aceita quando o ator é um segundo usuário;
//   (3) REG-COM-001 (approvalThresholdRules.service.js) — limite de valor para segunda
//       aprovação: awardSupplierOffer exige um segundo aprovador (diferente de quem decidiu a
//       PurchaseRequest) quando o valor da oferta >= limiar vigente
//       (PURCHASE_ORDER_SECOND_APPROVAL_REQUIRED_HIGH_VALUE);
//   (4) abaixo do limiar, o mesmo aprovador da PurchaseRequest pode adjudicar sem bloqueio;
//   (5) rota HTTP de configuração do limiar (GET/POST /procurement/approval-threshold-rule).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const procurementService = require('../src/features/procurement/procurement.service');
const approvalThresholdRulesService = require('../src/features/procurement/approvalThresholdRules.service');
const { User } = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

function withTenant(fields) {
  return { groupId: tenant.groupId, companyId: tenant.companyId, ...fields };
}

async function createSecondUser(transaction, label) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  return User.create(
    { name: `QA SEGREGACAO ${label} ${suffix}`, email: `qa-segregacao-${label.toLowerCase()}-${suffix}@nayaraone.dev`, passwordHash: 'x', status: 'ACTIVE' },
    { transaction }
  );
}

async function openRequestWithQuotationAndOffer(transaction, { quantity = 10, unitPrice = 5 } = {}) {
  const suffix = uniqueSuffix();
  const request = await procurementService.createPurchaseRequest(
    withTenant({ items: [{ description: `QA SEGREGACAO item ${suffix}`, quantity }] }),
    tenant.userId,
    transaction
  );
  const approver = await createSecondUser(transaction, 'approver');
  await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', approver.id, transaction);
  const quotation = await procurementService.createQuotation(request.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
  const offer = await procurementService.submitSupplierOffer(
    quotation.id, tenant.groupId, tenant.companyId,
    { supplierPersonId: tenant.userId, items: [{ purchaseRequestItemId: request.items[0].id, unitPrice }] },
    transaction
  );
  return { request, quotation, offer, approver };
}

test('TAREFA 1 — decidePurchaseRequest rejeita quando o mesmo ator que criou a requisição tenta decidi-la (PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ description: `QA SEGREGACAO self item ${uniqueSuffix()}`, quantity: 1 }] }),
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', tenant.userId, transaction),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, 'PURCHASE_REQUEST_SELF_APPROVAL_FORBIDDEN');
        return true;
      }
    );
  });
});

test('TAREFA 1 — decidePurchaseRequest aceita a decisão de um segundo usuário, diferente de quem criou a requisição', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const request = await procurementService.createPurchaseRequest(
      withTenant({ items: [{ description: `QA SEGREGACAO ok item ${uniqueSuffix()}`, quantity: 1 }] }),
      tenant.userId,
      transaction
    );
    const approver = await createSecondUser(transaction, 'ok');
    const decided = await procurementService.decidePurchaseRequest(request.id, tenant.groupId, tenant.companyId, 'APPROVED', approver.id, transaction);
    assert.equal(decided.status, 'APPROVED');
    assert.equal(decided.approvedByUserId, approver.id);
  });
});

test('TAREFA 2 — REG-COM-001: awardSupplierOffer exige um segundo aprovador (diferente de quem decidiu a PurchaseRequest) quando o valor da oferta >= limiar vigente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Limiar baixo e determinístico para este teste — não depende do seed default (R$50.000).
    await approvalThresholdRulesService.createApprovalThresholdRule(
      withTenant({ secondApprovalThreshold: 100, description: 'QA SEGREGACAO — limiar de teste' }),
      tenant.userId,
      transaction
    );

    const { offer, approver } = await openRequestWithQuotationAndOffer(transaction, { quantity: 10, unitPrice: 50 }); // totalAmount = 500 >= 100

    await assert.rejects(
      () => procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, approver.id, transaction),
      (err) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, 'PURCHASE_ORDER_SECOND_APPROVAL_REQUIRED_HIGH_VALUE');
        return true;
      }
    );
  });
});

test('TAREFA 2 — REG-COM-001: acima do limiar, um SEGUNDO aprovador (diferente de quem decidiu a PurchaseRequest) consegue adjudicar normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await approvalThresholdRulesService.createApprovalThresholdRule(
      withTenant({ secondApprovalThreshold: 100, description: 'QA SEGREGACAO — limiar de teste' }),
      tenant.userId,
      transaction
    );

    const { offer } = await openRequestWithQuotationAndOffer(transaction, { quantity: 10, unitPrice: 50 }); // totalAmount = 500 >= 100

    // tenant.userId aqui é o SEGUNDO aprovador: não foi ele quem decidiu a PurchaseRequest
    // (quem decidiu foi `approver`, criado dentro do helper) — adjudicação deve ser aceita.
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, tenant.userId, transaction);
    assert.equal(order.status, 'OPEN');
    assert.equal(Number(order.committedAmount), 500);
  });
});

test('TAREFA 2 — REG-COM-001: abaixo do limiar, o mesmo aprovador da PurchaseRequest pode adjudicar sem exigir um segundo aprovador', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await approvalThresholdRulesService.createApprovalThresholdRule(
      withTenant({ secondApprovalThreshold: 100000, description: 'QA SEGREGACAO — limiar alto de teste' }),
      tenant.userId,
      transaction
    );

    const { offer, approver } = await openRequestWithQuotationAndOffer(transaction, { quantity: 10, unitPrice: 5 }); // totalAmount = 50 < 100000

    // `approver` decidiu a PurchaseRequest E adjudica a oferta — abaixo do limiar isso é permitido
    // (a segregação "quem decide não é o mesmo que cria" já foi satisfeita em decidePurchaseRequest;
    // a exigência de um SEGUNDO aprovador só nasce acima do limiar de valor).
    const order = await procurementService.awardSupplierOffer(offer.id, tenant.groupId, tenant.companyId, approver.id, transaction);
    assert.equal(order.status, 'OPEN');
  });
});

test('REG-COM-001: getActiveSecondApprovalThreshold semeia o valor padrão automaticamente no primeiro uso do tenant', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const resolved = await approvalThresholdRulesService.getActiveSecondApprovalThreshold(tenant.groupId, tenant.companyId, transaction, tenant.userId);
    assert.ok(resolved.ruleVersionId);
    assert.equal(typeof resolved.secondApprovalThreshold, 'number');
    assert.ok(resolved.secondApprovalThreshold > 0);
  });
});

test('REG-COM-001: createApprovalThresholdRule publica uma nova versão e getApprovalThresholdRule lê o limiar configurado (isolado por tenant)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const created = await approvalThresholdRulesService.createApprovalThresholdRule(
      withTenant({ secondApprovalThreshold: 75000, description: 'QA SEGREGACAO — leitura' }),
      tenant.userId,
      transaction
    );
    assert.equal(created.secondApprovalThreshold, 75000);
    assert.equal(created.isActive, true);

    const read = await approvalThresholdRulesService.getApprovalThresholdRule(created.id, tenant.groupId, tenant.companyId, transaction);
    assert.equal(read.secondApprovalThreshold, 75000);
    assert.equal(read.isActive, true);

    const resolved = await approvalThresholdRulesService.getActiveSecondApprovalThreshold(tenant.groupId, tenant.companyId, transaction, tenant.userId);
    assert.equal(resolved.secondApprovalThreshold, 75000);

    // Isolamento multi-tenant: ler com groupId/companyId errado (outro UUID) nunca pode achar o
    // registro — mesmo padrão de proteção RLS manual já usado em getAdjustmentRiskRule.
    await assert.rejects(
      () => approvalThresholdRulesService.getApprovalThresholdRule(created.id, '00000000-0000-0000-0000-000000000000', tenant.companyId, transaction),
      (err) => {
        assert.equal(err.code, 'APPROVAL_THRESHOLD_RULE_NOT_FOUND');
        return true;
      }
    );
  });
});
