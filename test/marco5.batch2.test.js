'use strict';

/**
 * marco5.batch2.test.js — fechamento dos itens M5-10, M5-12, M5-33 e M5-34 do Marco 5
 * (Contratos/Locação/Jurídico). Tudo roda contra o banco real de homologação, pelo mesmo
 * caminho de RLS da aplicação (SET LOCAL app.group_id/app.company_id/app.user_id), dentro de
 * transação com rollback — nenhum dado fica no banco compartilhado.
 *
 *   M5-10 — gate dedicado da transição SIGNED -> ACTIVE (assertActivationGate).
 *   M5-12 — o envelope enviado ao provedor carrega o content_hash EXATO da ContractVersion.
 *   M5-33 — jornada E2E completa de locação (proposta aceita -> chaves entregues + relatório).
 *   M5-34 — jornada E2E completa do jurídico (processo -> prazo -> alerta -> escalonamento ->
 *           dossiê -> export verificável -> encerramento auditado).
 */

const crypto = require('crypto');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { sequelize, getSeedTenant, withRollbackTenantTransaction, uniqueSuffix } = require('./testHelpers');
const peopleService = require('../src/features/people/people.service');
const propertiesService = require('../src/features/properties/properties.service');
const opportunitiesService = require('../src/features/crm/opportunities.service');
const proposalsService = require('../src/features/crm/proposals.service');
const contractsService = require('../src/features/legal/contracts.service');
const contractVersionsService = require('../src/features/legal/contractVersions.service');
const signaturesService = require('../src/features/legal/signatures.service');
const guaranteesService = require('../src/features/legal/guarantees.service');
const inspectionsService = require('../src/features/legal/inspections.service');
const keyDeliveriesService = require('../src/features/legal/keyDeliveries.service');
const legalCasesService = require('../src/features/legal/legalCases.service');
const legalDeadlinesService = require('../src/features/legal/legalDeadlines.service');
const evidencePackagesService = require('../src/features/legal/evidencePackages.service');
const { processDeadlinesInTransaction } = require('../src/engines/jobs/legalDeadlineAlertJob');
const { ClicksignSignatureAdapter, ZapSignSignatureAdapter } = require('../src/features/legal/adapters/SignatureAdapter');
const {
  File,
  FileLink,
  Person,
  Notification,
  LegalDeadline,
  AuditLog,
  EvidencePackageAccessLog,
} = require('../src/models');

let tenant;

before(async () => {
  tenant = await getSeedTenant();
});

after(async () => {
  await sequelize.close();
});

async function createDocumentFile(transaction, prefix = 'm5b2') {
  const suffix = uniqueSuffix();
  return File.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      storageKey: `${prefix}/${suffix}.pdf`,
      fileName: `${prefix}-${suffix}.pdf`,
      mimeType: 'application/pdf',
      uploadedByUserId: tenant.userId,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

async function createPerson(transaction, label) {
  return Person.create(
    {
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      personType: 'PF',
      legalName: `${label} ${uniqueSuffix()}`,
      createdBy: tenant.userId,
      updatedBy: tenant.userId,
    },
    { transaction }
  );
}

/**
 * Leva um contrato de locação de DRAFT até SIGNED pelo fluxo REAL (sem atalho nenhum):
 * partes -> documento -> revisão -> aprovação -> assinatura sandbox -> webhook de cada parte.
 */
async function buildSignedLease(transaction, { withProperty = false } = {}) {
  const suffix = uniqueSuffix();
  let propertyId = null;
  if (withProperty) {
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `M5B2 Imóvel ${suffix}`, internalCode: `M5B2-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    propertyId = property.id;
  }
  const contract = await contractsService.createContract(
    { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 2500, propertyId },
    tenant.userId,
    transaction
  );
  const landlord = await createPerson(transaction, 'M5B2 Locador');
  const lessee = await createPerson(transaction, 'M5B2 Locatário');
  await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
  await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, transaction);

  await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
  const file = await createDocumentFile(transaction);
  const version = await contractVersionsService.createContractVersion(
    contract.id,
    { content: `M5B2 — corpo do contrato ${suffix}`, documentFileId: file.id },
    tenant.userId,
    transaction
  );
  await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
  await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);

  const signatures = await signaturesService.initiateSignature(version.id, [landlord.id, lessee.id], tenant.userId, transaction);
  for (const signature of signatures) {
    await signaturesService.handleSignatureWebhook(signature.externalSignatureId, {}, transaction);
  }
  await contract.reload({ transaction });
  assert.equal(contract.status, 'SIGNED');
  return { contract, version, landlord, lessee, signatures };
}

// ---------------------------------------------------------------------------
// M5-10 — Gate dedicado da transição SIGNED -> ACTIVE
// ---------------------------------------------------------------------------

test('M5-10: SIGNED forjado (sem documento nem assinatura) NÃO vira ACTIVE — o gate de ativação reconfere do zero', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Ataque: o contrato nunca passou por nenhum gate anterior. Colocamos o status em SIGNED
    // direto na instância (é exatamente o que um chamador interno mal-intencionado, ou uma
    // linha adulterada no banco, entregariam a transitionContractStatus) e pedimos ACTIVE.
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 999 },
      tenant.userId,
      transaction
    );
    contract.status = 'SIGNED';

    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'ACTIVE', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_ACTIVATION_GATE');
        assert.match(err.message, /versão de documento/i);
        return true;
      },
      'o gate de ativação precisa barrar um SIGNED que nunca teve documento'
    );

    // A transitividade dos gates anteriores não foi exercida: o contrato segue não-ativo.
    const persisted = await contractsService.getContract(contract.id, transaction);
    assert.notEqual(persisted.status, 'ACTIVE');
  });
});

test('M5-10: contrato com documento mas com assinatura ainda PENDENTE não é ativado', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    const landlord = await createPerson(transaction, 'M5-10 Locador');
    const lessee = await createPerson(transaction, 'M5-10 Locatário');
    await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
    await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    const file = await createDocumentFile(transaction);
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content: `M5-10 corpo ${suffix}`, documentFileId: file.id },
      tenant.userId,
      transaction
    );
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);

    const signatures = await signaturesService.initiateSignature(version.id, [landlord.id, lessee.id], tenant.userId, transaction);
    // Só UMA das duas partes assina; o contrato é forçado a SIGNED na instância.
    await signaturesService.handleSignatureWebhook(signatures[0].externalSignatureId, {}, transaction);
    contract.status = 'SIGNED';

    await assert.rejects(
      () => contractsService.transitionContractStatus(contract, 'ACTIVE', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_ACTIVATION_GATE');
        assert.match(err.message, /assinaturas/i);
        return true;
      }
    );
  });
});

test('M5-10: garantia cadastrada mas NENHUMA ACTIVE bloqueia a ativação; sem nenhuma garantia, ativa normalmente', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    // Caso 1 — contrato com garantia cadastrada e depois CANCELADA: ativar seria entregar o
    // imóvel sem a proteção que o próprio contrato previu.
    const comGarantia = await buildSignedLease(transaction);
    const fiador = await createPerson(transaction, 'M5-10 Fiador');
    const guarantee = await guaranteesService.createGuarantee(
      comGarantia.contract.id,
      { guaranteeType: 'GUARANTOR', guarantorPersonId: fiador.id, value: 7500 },
      tenant.userId,
      transaction
    );
    await guaranteesService.updateGuarantee(guarantee.id, { status: 'CANCELLED' }, tenant.userId, transaction);

    await assert.rejects(
      () => contractsService.transitionContractStatus(comGarantia.contract, 'ACTIVE', tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_CONTRACT_ACTIVATION_GATE');
        assert.match(err.message, /garantias/i);
        return true;
      }
    );

    // Reativando a garantia, a mesma ativação passa a ser permitida.
    await guaranteesService.updateGuarantee(guarantee.id, { status: 'ACTIVE' }, tenant.userId, transaction);
    const ativado = await contractsService.transitionContractStatus(comGarantia.contract, 'ACTIVE', tenant.userId, transaction);
    assert.equal(ativado.status, 'ACTIVE');

    // Caso 2 — DECISÃO DOCUMENTADA: contrato SEM NENHUMA garantia cadastrada não é bloqueado
    // (garantia obrigatória não é regra definida no Caderno; ver assertActivationGate).
    const semGarantia = await buildSignedLease(transaction);
    const ativadoSemGarantia = await contractsService.transitionContractStatus(
      semGarantia.contract,
      'ACTIVE',
      tenant.userId,
      transaction
    );
    assert.equal(ativadoSemGarantia.status, 'ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// M5-12 — external_id do envelope = content_hash EXATO da ContractVersion
// ---------------------------------------------------------------------------

/**
 * Os adapters reais (Clicksign/ZapSign) fazem HTTP de verdade via `fetch` e buscam nome/e-mail
 * dos signatários com `Person.findAll` (sem transação, fora do contexto de tenant). Aqui
 * interceptamos os DOIS: `fetch` para capturar o payload realmente enviado, e `Person.findAll`
 * para devolver um signatário com e-mail — o alvo do teste é o corpo da requisição, não o I/O.
 */
function withInterceptedProvider(responder, fn) {
  const originalFetch = global.fetch;
  const originalFindAll = Person.findAll;
  const calls = [];

  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method, body });
    const payload = responder({ url: String(url), method: options.method, body });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  };
  Person.findAll = async () => [
    {
      id: 'fake-person-id',
      legalName: 'Signatário de Teste',
      contacts: [{ contactType: 'EMAIL', isPrimary: true, valueNormalized: 'signatario@teste.nayaraone.dev' }],
    },
  ];

  const restore = () => {
    global.fetch = originalFetch;
    Person.findAll = originalFindAll;
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(restore);
}

test('M5-12: Clicksign recebe external_id EXATAMENTE igual ao content_hash da ContractVersion', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    const file = await createDocumentFile(transaction);
    const content = `M5-12 Clicksign — corpo do contrato ${suffix}`;
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content, documentFileId: file.id },
      tenant.userId,
      transaction
    );

    // O hash gravado é, de fato, o SHA-256 do conteúdo do documento (não um id qualquer).
    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(version.contentHash, expectedHash);

    await withInterceptedProvider(
      ({ url }) => (url.endsWith('/envelopes') ? { data: { id: 'envelope-123' } } : { data: { id: 'signer-1' } }),
      async (calls) => {
        const adapter = new ClicksignSignatureAdapter({ apiToken: 'fake-token' });
        const result = await adapter.requestSignature(version, ['fake-person-id']);
        assert.equal(result.providerEnvelopeId, 'envelope-123');

        const envelopeCall = calls.find((c) => c.url.endsWith('/envelopes'));
        assert.ok(envelopeCall, 'o adapter precisa ter chamado POST /envelopes');
        const sentExternalId = envelopeCall.body.data.attributes.external_id;
        assert.equal(sentExternalId, version.contentHash, 'external_id enviado tem que ser o content_hash da versão');
        assert.equal(sentExternalId, expectedHash);
        assert.notEqual(sentExternalId, version.id, 'não pode cair no fallback do id quando existe hash');
      }
    );
  });
});

test('M5-12: ZapSign recebe external_id EXATAMENTE igual ao content_hash da ContractVersion', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();
    const contract = await contractsService.createContract(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractType: 'LEASE', totalValue: 1000 },
      tenant.userId,
      transaction
    );
    const file = await createDocumentFile(transaction);
    const content = `M5-12 ZapSign — corpo do contrato ${suffix}`;
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content, documentFileId: file.id },
      tenant.userId,
      transaction
    );
    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    assert.equal(version.contentHash, expectedHash);

    await withInterceptedProvider(
      () => ({ token: 'doc-token-abc', signers: [{ token: 'signer-token-1' }] }),
      async (calls) => {
        const adapter = new ZapSignSignatureAdapter({ apiToken: 'fake-token' });
        const result = await adapter.requestSignature(version, ['fake-person-id']);
        assert.equal(result.providerEnvelopeId, 'doc-token-abc');

        const docCall = calls.find((c) => c.url.endsWith('/docs/'));
        assert.ok(docCall, 'o adapter precisa ter chamado POST /docs/');
        assert.equal(docCall.body.external_id, version.contentHash);
        assert.equal(docCall.body.external_id, expectedHash);
        assert.notEqual(docCall.body.external_id, version.id);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// M5-33 — Jornada E2E completa de locação
// ---------------------------------------------------------------------------

/**
 * FRONTEIRA COBERTA (nota honesta, mesmo padrão do M3-25/M4-28): esta jornada cobre do aceite
 * da proposta (CRM) até a entrega das chaves e o relatório de vistoria com hash (Jurídico).
 * A geração de cobrança/repasse do aluguel é do módulo FINANCEIRO, que está sendo alterado em
 * paralelo por outro agente e está fora do escopo deste worktree — por isso a jornada termina
 * na entrega de chaves + relatório, e NÃO afirmamos nada sobre o ciclo financeiro do contrato.
 * O elo já existe e é testado em outro lugar (o evento de domínio contract.status_changed é
 * publicado na ativação — ver publishContractStatusChanged em legalEvents.service.js).
 */
test('M5-33: jornada E2E de locação — proposta aceita, contrato ativo, vistoria, chaves e relatório com hash', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();

    // 1) Imóvel + pessoas reais.
    const property = await propertiesService.createProperty(
      { groupId: tenant.groupId, companyId: tenant.companyId, title: `E2E Locação ${suffix}`, internalCode: `E2E-${suffix}`, propertyType: 'RESIDENTIAL' },
      tenant.userId,
      transaction
    );
    const landlord = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `E2E Locador ${suffix}` },
      tenant.userId,
      transaction
    );
    const lessee = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `E2E Locatário ${suffix}` },
      tenant.userId,
      transaction
    );
    const guarantor = await peopleService.createPerson(
      { groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `E2E Fiador ${suffix}` },
      tenant.userId,
      transaction
    );

    // 2) Oportunidade -> proposta enviada -> proposta ACEITA (origem real do contrato).
    const opportunity = await opportunitiesService.createOpportunity(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        personId: lessee.id,
        propertyId: property.id,
        stage: 'NEGOTIATION',
        nextAction: 'Fechar contrato de locação',
        nextActionDueAt: new Date(Date.now() + 86400000),
      },
      tenant.userId,
      transaction
    );
    const proposal = await proposalsService.createProposal(
      { groupId: tenant.groupId, companyId: tenant.companyId, opportunityId: opportunity.id, propertyId: property.id, value: 2800, status: 'SENT' },
      tenant.userId,
      transaction
    );
    const acceptedProposal = await proposalsService.updateProposalStatus(proposal.id, { status: 'ACCEPTED' }, tenant.userId, transaction);
    assert.equal(acceptedProposal.status, 'ACCEPTED');

    // 3) Contrato nascido da oportunidade aceita.
    const contract = await contractsService.createContract(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        contractType: 'LEASE',
        propertyId: property.id,
        opportunityId: opportunity.id,
        totalValue: acceptedProposal.value,
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      },
      tenant.userId,
      transaction
    );
    await contractsService.addContractParty(contract.id, { personId: landlord.id, partyRole: 'LANDLORD' }, tenant.userId, transaction);
    await contractsService.addContractParty(contract.id, { personId: lessee.id, partyRole: 'TENANT' }, tenant.userId, transaction);
    await contractsService.addContractParty(contract.id, { personId: guarantor.id, partyRole: 'GUARANTOR' }, tenant.userId, transaction);

    // 4) Versão com documento REAL (File) + hash verificável.
    await contractsService.transitionContractStatus(contract, 'DOCUMENTS_PENDING', tenant.userId, transaction);
    const contractFile = await createDocumentFile(transaction, 'e2e-lease');
    const content = `E2E — CONTRATO DE LOCAÇÃO ${suffix}\nAluguel: R$ 2.800,00`;
    const version = await contractVersionsService.createContractVersion(
      contract.id,
      { content, documentFileId: contractFile.id },
      tenant.userId,
      transaction
    );
    assert.equal(version.contentHash, crypto.createHash('sha256').update(content).digest('hex'));

    // 5) Revisão jurídica -> aprovação.
    await contractsService.transitionContractStatus(contract, 'LEGAL_REVIEW', tenant.userId, transaction);
    await contractsService.transitionContractStatus(contract, 'APPROVED', tenant.userId, transaction);

    // 6) Garantia (fiador) ACTIVE.
    const guarantee = await guaranteesService.createGuarantee(
      contract.id,
      { guaranteeType: 'GUARANTOR', guarantorPersonId: guarantor.id, value: 8400, startsAt: new Date() },
      tenant.userId,
      transaction
    );
    assert.equal(guarantee.status, 'ACTIVE');

    // 7) Assinatura de TODAS as partes, pelo fluxo real (adapter sandbox + webhook).
    await contractsService.transitionContractStatus(contract, 'SIGNING', tenant.userId, transaction);
    const signatures = await signaturesService.initiateSignature(
      version.id,
      [landlord.id, lessee.id, guarantor.id],
      tenant.userId,
      transaction
    );
    assert.equal(signatures.length, 3);
    let lastWebhook;
    for (const signature of signatures) {
      lastWebhook = await signaturesService.handleSignatureWebhook(signature.externalSignatureId, {}, transaction);
    }
    assert.equal(lastWebhook.contractTransitioned, true, 'a última assinatura leva o contrato a SIGNED sozinha');
    await contract.reload({ transaction });
    assert.equal(contract.status, 'SIGNED');

    // 8) Ativação — passa pelo gate do M5-10 com tudo em ordem.
    await contractsService.transitionContractStatus(contract, 'ACTIVE', tenant.userId, transaction);
    assert.equal(contract.status, 'ACTIVE');

    // 9) Vistoria de entrada completa (itens + foto via File/FileLink).
    const inspection = await inspectionsService.createInspection(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        propertyId: property.id,
        contractId: contract.id,
        inspectorUserId: tenant.userId,
        inspectionType: 'CHECK_IN',
        scheduledAt: new Date(),
      },
      tenant.userId,
      transaction
    );
    const itemSala = await inspectionsService.addInspectionItem(
      inspection.id,
      { itemName: 'Piso da sala', condition: 'GOOD', notes: 'Sem avarias.' },
      tenant.userId,
      transaction
    );
    await inspectionsService.addInspectionItem(
      inspection.id,
      {
        itemName: 'Porta do quarto',
        condition: 'DAMAGED',
        damageDescription: 'Fechadura empenada já na entrega.',
        estimatedBudget: 320.5,
        responsibleParty: 'LANDLORD',
      },
      tenant.userId,
      transaction
    );
    const photo = await File.create(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        storageKey: `e2e-inspection/${suffix}.jpg`,
        fileName: `porta-${suffix}.jpg`,
        mimeType: 'image/jpeg',
        uploadedByUserId: tenant.userId,
        createdBy: tenant.userId,
        updatedBy: tenant.userId,
      },
      { transaction }
    );
    const mediaLink = await inspectionsService.attachInspectionItemMedia(
      itemSala.id,
      { fileId: photo.id, mediaType: 'PHOTO' },
      tenant.userId,
      transaction
    );
    const persistedLink = await FileLink.findByPk(mediaLink.id, { transaction });
    assert.equal(persistedLink.relatedEntityId, itemSala.id);

    // 10) Chaves criadas — e BLOQUEADAS enquanto a vistoria não estiver concluída.
    const keyDelivery = await keyDeliveriesService.createKeyDelivery(
      { groupId: tenant.groupId, companyId: tenant.companyId, contractId: contract.id, deliveredToPersonId: lessee.id },
      tenant.userId,
      transaction
    );
    await assert.rejects(
      () => keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, tenant.userId, transaction),
      (err) => {
        assert.equal(err.code, 'LEGAL_KEY_DELIVERY_BLOCKED');
        return true;
      },
      'com contrato ATIVO mas vistoria ainda em aberto, a chave não pode sair'
    );

    // 11) Vistoria concluída e assinada pelas três partes.
    await inspectionsService.completeInspection(inspection.id, tenant.userId, transaction);
    for (const partyRole of ['LANDLORD', 'TENANT', 'INSPECTOR']) {
      await inspectionsService.signInspection(
        inspection.id,
        { partyRole, signaturePayload: `Concordo com o laudo de entrada (${partyRole}) — ${suffix}` },
        tenant.userId,
        transaction
      );
    }
    const inspectionSignatures = await inspectionsService.listInspectionSignatures(inspection.id, transaction);
    assert.equal(inspectionSignatures.length, 3);

    // 12) Agora a chave sai — com quem entregou, quem recebeu e quando.
    const released = await keyDeliveriesService.releaseKeyDelivery(keyDelivery.id, tenant.userId, transaction);
    assert.equal(released.status, 'RELEASED');
    assert.equal(released.deliveredToPersonId, lessee.id);
    assert.equal(released.deliveredByUserId, tenant.userId);
    assert.ok(released.deliveredAt);

    // 13) Relatório da vistoria com hash verificável (PDF real, íntegro).
    const report = await inspectionsService.generateInspectionReport(inspection.id, tenant.userId, transaction);
    assert.match(report.reportHash, /^[0-9a-f]{64}$/);
    const fetched = await inspectionsService.getInspectionReport(inspection.id, transaction);
    assert.equal(fetched.reportHash, report.reportHash);
    assert.equal(fetched.pdfBytes.subarray(0, 4).toString('utf8'), '%PDF');
    assert.equal(
      crypto.createHash('sha256').update(fetched.pdfBytes).digest('hex'),
      report.reportHash,
      'o hash publicado tem que bater byte-a-byte com o PDF entregue'
    );
  });
});

// ---------------------------------------------------------------------------
// M5-34 — Jornada E2E completa do jurídico
// ---------------------------------------------------------------------------

test('M5-34: jornada E2E jurídica — processo, prazo, alerta, escalonamento, dossiê, export verificável e encerramento', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const suffix = uniqueSuffix();

    // 1) Processo com partes formais e fase inicial.
    const legalCase = await legalCasesService.createLegalCase(
      {
        groupId: tenant.groupId,
        companyId: tenant.companyId,
        caseType: 'LITIGATION',
        caseNumber: `E2E-JUR-${suffix}`,
        summary: `Ação de despejo por falta de pagamento ${suffix}`,
        phase: 'INITIAL_PETITION',
        responsibleUserId: tenant.userId,
        escalationUserId: tenant.userId,
      },
      tenant.userId,
      transaction
    );
    const autor = await createPerson(transaction, 'E2E Autor');
    const reu = await createPerson(transaction, 'E2E Réu');
    await legalCasesService.addLegalCaseParty(legalCase.id, { personId: autor.id, partyRole: 'PLAINTIFF' }, tenant.userId, transaction);
    await legalCasesService.addLegalCaseParty(legalCase.id, { personId: reu.id, partyRole: 'DEFENDANT' }, tenant.userId, transaction);
    const parties = await legalCasesService.listLegalCaseParties(legalCase.id, transaction);
    assert.equal(parties.length, 2);

    // 2) Prazo processual que vence em 12h -> severidade DUE_SOON.
    const deadline = await legalDeadlinesService.createLegalDeadline(
      legalCase.id,
      { description: `Contestação ${suffix}`, dueAt: new Date(Date.now() + 12 * 60 * 60 * 1000) },
      tenant.userId,
      transaction
    );
    assert.equal(legalDeadlinesService.computeSeverity(deadline), 'DUE_SOON');

    // 3) Job de alerta: notifica o responsável pela proximidade do vencimento.
    const dueSoonRun = await processDeadlinesInTransaction(transaction);
    assert.ok(dueSoonRun.alerted >= 1);
    await deadline.reload({ transaction });
    assert.equal(deadline.lastAlertedSeverity, 'DUE_SOON');
    const dueSoonNotifications = await Notification.findAll({
      where: { userId: tenant.userId, title: 'Prazo jurídico próximo de vencer' },
      transaction,
    });
    assert.ok(dueSoonNotifications.length >= 1, 'o responsável precisa ser notificado do DUE_SOON');

    // 4) O prazo vence sem ação -> nova rodada do job alerta OVERDUE (severidade piorou).
    await LegalDeadline.update(
      { dueAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      { where: { id: deadline.id }, transaction }
    );
    const overdueRun = await processDeadlinesInTransaction(transaction);
    assert.ok(overdueRun.alerted >= 1);
    await deadline.reload({ transaction });
    assert.equal(deadline.lastAlertedSeverity, 'OVERDUE');
    assert.ok(deadline.firstOverdueAlertedAt);
    assert.equal(deadline.escalatedAt, null, 'não escala no mesmo instante do primeiro alerta de OVERDUE');

    // 5) Envelhece 25h sem ninguém tratar -> escalonamento dispara.
    await LegalDeadline.update(
      { firstOverdueAlertedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
      { where: { id: deadline.id }, transaction }
    );
    const escalationRun = await processDeadlinesInTransaction(transaction);
    assert.equal(escalationRun.escalated, 1);
    await deadline.reload({ transaction });
    assert.ok(deadline.escalatedAt);
    const escalationNotifications = await Notification.findAll({
      where: { userId: tenant.userId, title: 'ESCALONAMENTO — prazo jurídico vencido sem tratativa' },
      transaction,
    });
    assert.ok(escalationNotifications.length >= 1);

    // 6) Dossiê de provas vinculado ao caso.
    const evidencePackage = await evidencePackagesService.createEvidencePackage(
      legalCase.id,
      [
        { type: 'DEADLINE', description: `Prazo perdido ${suffix}`, referenceId: deadline.id, hash: null },
        { type: 'NOTIFICATION', description: `Notificação extrajudicial ${suffix}`, referenceId: null, hash: crypto.createHash('sha256').update(`notif-${suffix}`).digest('hex') },
      ],
      tenant.userId,
      transaction
    );
    assert.match(evidencePackage.packageHash, /^[0-9a-f]{64}$/);

    // 7) Acesso ao dossiê grava cadeia de custódia (VIEWED).
    await evidencePackagesService.viewEvidencePackage(evidencePackage.id, tenant.userId, transaction);
    let chain = await evidencePackagesService.listEvidenceAccessLog(evidencePackage.id, transaction);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].action, 'VIEWED');
    assert.equal(chain[0].accessedByUserId, tenant.userId);

    // 8) Export -> segunda linha na cadeia (EXPORTED) e JSON autocontido.
    const exported = await evidencePackagesService.exportEvidencePackage(evidencePackage.id, tenant.userId, transaction);
    chain = await evidencePackagesService.listEvidenceAccessLog(evidencePackage.id, transaction);
    assert.equal(chain.length, 2);
    assert.deepEqual(chain.map((c) => c.action), ['VIEWED', 'EXPORTED']);
    const chainRows = await EvidencePackageAccessLog.count({ where: { evidencePackageId: evidencePackage.id }, transaction });
    assert.equal(chainRows, 2);

    // 9) Integridade do export: bate com o hash gravado no banco.
    const verification = evidencePackagesService.verifyEvidencePackageIntegrity(exported, evidencePackage.packageHash);
    assert.equal(verification.valid, true);
    assert.equal(verification.recomputedHash, evidencePackage.packageHash);

    // 10) Encerramento do processo (fase CLOSED) com auditoria específica de mudança de fase.
    const closed = await legalCasesService.updateLegalCase(
      legalCase.id,
      { phase: 'CLOSED', status: 'CLOSED', summary: `${legalCase.summary} — encerrado por acordo` },
      tenant.userId,
      transaction
    );
    assert.equal(closed.phase, 'CLOSED');
    const phaseAudits = await AuditLog.findAll({
      where: { entityId: legalCase.id, action: 'legal.case.phase_change' },
      transaction,
    });
    assert.ok(phaseAudits.length >= 1, 'a mudança de fase precisa gerar auditoria dedicada');
    assert.match(phaseAudits[phaseAudits.length - 1].reason, /INITIAL_PETITION -> CLOSED/);
  });
});
