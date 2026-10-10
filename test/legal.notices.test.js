'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const contractsService = require('../src/features/legal/contracts.service');
const noticesService = require('../src/features/legal/notices.service');
const AppError = require('../src/utils/AppError');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createLeaseContract(transaction) {
  return contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
    tenant.userId,
    transaction
  );
}

// Caderno Anexo I "13. Aditivos e notificações": "IA pode rascunhar; envio jurídico sensível
// requer revisão humana."
test('notice sensível (draftedByAi) não pode ser enviada sem passar por PENDING_REVIEW -> APPROVED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const notice = await noticesService.createNotice(
      { contractId: contract.id, channel: 'EMAIL', content: 'Rascunho gerado pela NAY.', draftedByAi: true },
      tenant.userId,
      transaction
    );
    assert.equal(notice.status, 'DRAFT');

    // Tentar aprovar direto de DRAFT (pulando revisão) é bloqueado.
    await assert.rejects(
      () => noticesService.approveNotice(notice.id, tenant.userId, transaction),
      (err) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.code, 'LEGAL_NOTICE_REVIEW_REQUIRED');
        return true;
      }
    );

    // Tentar enviar sem estar APPROVED é bloqueado.
    await assert.rejects(
      () => noticesService.sendNotice(notice.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_NOTICE_SEND_BLOCKED');
        return true;
      }
    );

    await noticesService.submitNoticeForReview(notice.id, tenant.userId, transaction);
    const approved = await noticesService.approveNotice(notice.id, tenant.userId, transaction);
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.reviewedByUserId, tenant.userId);

    const sent = await noticesService.sendNotice(notice.id, tenant.userId, transaction);
    assert.equal(sent.status, 'SENT');
    assert.ok(sent.sentAt);
  });
});

test('notice NÃO sensível pode ir direto de DRAFT para APPROVED (sem review obrigatória)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const notice = await noticesService.createNotice(
      { contractId: contract.id, channel: 'WHATSAPP', content: 'Aviso simples de manutenção programada.' },
      tenant.userId,
      transaction
    );
    const approved = await noticesService.approveNotice(notice.id, tenant.userId, transaction);
    assert.equal(approved.status, 'APPROVED');
    const sent = await noticesService.sendNotice(notice.id, tenant.userId, transaction);
    assert.equal(sent.status, 'SENT');
  });
});

test('registerDeliveryEvidence registra evidência de envio/recebimento e vira DELIVERED', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const contract = await createLeaseContract(transaction);
    const notice = await noticesService.createNotice(
      { contractId: contract.id, channel: 'POSTAL_MAIL', content: 'Notificação de reajuste.' },
      tenant.userId,
      transaction
    );
    await noticesService.approveNotice(notice.id, tenant.userId, transaction);
    await noticesService.sendNotice(notice.id, tenant.userId, transaction);

    const delivered = await noticesService.registerDeliveryEvidence(
      notice.id,
      { deliveryEvidenceFileId: '22222222-2222-2222-2222-222222222222' },
      tenant.userId,
      transaction
    );
    assert.equal(delivered.status, 'DELIVERED');
    assert.equal(delivered.deliveryEvidenceFileId, '22222222-2222-2222-2222-222222222222');
    assert.ok(delivered.deliveredAt);
  });
});

test('createNotice exige vínculo com Contract OU LegalCase, nunca os dois nem nenhum', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    await assert.rejects(
      () => noticesService.createNotice({ channel: 'EMAIL', content: 'sem vínculo' }, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_NOTICE_VALIDATION');
        return true;
      }
    );
  });
});
