'use strict';

/**
 * Apoio dos testes de Locação do fechamento do Marco 5 (não é arquivo de teste). A entrega de chaves passou a exigir,
 * pelo livro, o checklist da etapa KEY_DELIVERY satisfeito (Motor de Regras) e a via assinada do termo; as fixtures
 * que criam contrato ACTIVE direto no banco usam `keyDeliveryReady` para cumprir esses dois gates.
 */
const { waiveAllContractRequirements, uniqueSuffix } = require('./testHelpers');
const filesService = require('../src/features/files/files.service');

async function uploadTestFile(tenant, transaction, fileName = 'termo-entrega-assinado.pdf', mimeType = 'application/pdf') {
  return filesService.uploadFile(
    { groupId: tenant.groupId, companyId: tenant.companyId, fileName, mimeType, contentBase64: Buffer.from(`${fileName} ${uniqueSuffix()}`).toString('base64'), category: 'generic' },
    tenant.userId,
    transaction
  );
}

/** Dispensa o checklist do contrato (com motivo) e devolve o id da via assinada do termo de entrega. */
async function keyDeliveryReady(tenant, contractId, transaction) {
  await waiveAllContractRequirements(contractId, tenant.userId, transaction);
  const file = await uploadTestFile(tenant, transaction);
  return file.id;
}

/** Payload de seguro-fiança com todos os dados do livro (§9): fica ACTIVE na criação. */
async function completeInsurance(tenant, transaction, overrides = {}) {
  const policy = await uploadTestFile(tenant, transaction, 'apolice.pdf');
  return {
    guaranteeType: 'INSURANCE',
    value: 30000,
    startsAt: '2026-01-01',
    endsAt: '2030-12-31',
    providerName: 'Seguradora de Teste',
    policyNumber: `AP-${uniqueSuffix()}`,
    policyFileId: policy.id,
    premiumInstallments: [{ number: 1, dueDate: '2026-02-01', amount: 1200 }],
    renewalDueAt: '2030-11-30',
    autoRenew: false,
    ...overrides,
  };
}

/** Payload de fiador com pessoa, documentos, vigência e aceite (§9): fica ACTIVE na criação. */
async function completeGuarantor(tenant, transaction, guarantorPersonId, overrides = {}) {
  const doc = await uploadTestFile(tenant, transaction, 'documentos-fiador.pdf');
  const accept = await uploadTestFile(tenant, transaction, 'aceite-fiador.pdf');
  return { guaranteeType: 'GUARANTOR', guarantorPersonId, endsAt: '2030-12-31', documentFileIds: [doc.id], acceptanceFileId: accept.id, acceptedAt: '2026-01-02', ...overrides };
}

/** Fechamento M5 (§12): o pagamento de utilidade é de um vencimento, com comprovante — `{ referenceDueOn, proofFileId }`. */
async function paymentProof(tenant, transaction, referenceDueOn = '2026-10-10') {
  const file = await uploadTestFile(tenant, transaction, `comprovante-${referenceDueOn}.pdf`);
  return { referenceDueOn, proofFileId: file.id };
}

module.exports = { keyDeliveryReady, uploadTestFile, completeInsurance, completeGuarantor, paymentProof };
