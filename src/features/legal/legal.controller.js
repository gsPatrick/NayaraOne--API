'use strict';

const crypto = require('crypto');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const { getSetting, getDecryptedSetting } = require('../settings/settings.service');
const { sequelize, SignatureProviderRouting } = require('../../models');
const contractsService = require('./contracts.service');
const contractVersionsService = require('./contractVersions.service');
const signaturesService = require('./signatures.service');
const guaranteesService = require('./guarantees.service');
const inspectionsService = require('./inspections.service');
const keyDeliveriesService = require('./keyDeliveries.service');
const legalCasesService = require('./legalCases.service');
const legalDeadlinesService = require('./legalDeadlines.service');
const evidencePackagesService = require('./evidencePackages.service');

function withTenant(req) {
  return { ...req.body, groupId: req.auth.groupId, companyId: req.auth.companyId };
}

// --- Contracts ---
const createContract = catchAsync(async (req, res) => {
  const contract = await req.withTenantTransaction((t) => contractsService.createContract(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: contract });
});
const listContracts = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    contractsService.listContracts(t, { status: req.query.status, contractType: req.query.contractType, propertyId: req.query.propertyId })
  );
  return success(res, { data: items });
});
const getContract = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => contractsService.getContract(req.params.id, t));
  return success(res, { data: item });
});
const transitionContract = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction(async (t) => {
    const contract = await contractsService.getContract(req.params.id, t);
    return contractsService.transitionContractStatus(contract, req.body.targetStatus, req.auth.userId, t);
  });
  return success(res, { data: item });
});
const addContractParty = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => contractsService.addContractParty(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const correctContractData = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => contractsService.correctContractData(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const listContractParties = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => contractsService.listContractParties(req.params.id, t));
  return success(res, { data: items });
});

// --- Contract versions ---
const createContractVersion = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => contractVersionsService.createContractVersion(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listContractVersions = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => contractVersionsService.listContractVersions(req.params.id, t));
  return success(res, { data: items });
});

// --- Signatures ---
const initiateSignature = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    signaturesService.initiateSignature(req.params.id, req.body.signerPersonIds, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: items });
});
const listSignaturesByContractVersion = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => signaturesService.listSignaturesByContractVersion(req.params.id, t));
  return success(res, { data: items });
});
// Webhook de assinatura — endpoint AUTENTICADO (mantido por compatibilidade/testes internos):
// exige o MESMO authMiddleware/tenantMiddleware das demais rotas de legal ("legal:sign"). O
// webhook PÚBLICO de verdade, chamado pelo Clicksign sem JWT nenhum, é `clicksignPublicWebhook`
// abaixo — rota distinta, fora do authMiddleware (ver legal.routes.js).

const WEBHOOK_HEADER_BY_PROVIDER = {
  // Confirmado contra a documentação oficial do Clicksign (developers.clicksign.com,
  // 18/09/2026): header "Content-Hmac", valor "sha256=<hex>". ZapSign permanece assumido
  // (mesmo esquema hipotético) até haver credencial real para confirmar.
  clicksign: 'content-hmac',
  zapsign: 'x-zapsign-signature',
};

const WEBHOOK_SECRET_SETTING_BY_PROVIDER = {
  clicksign: 'legal.clicksign_webhook_secret',
  zapsign: 'legal.zapsign_webhook_secret',
};

// Clicksign NÃO usa HMAC de verdade (chave como key do HMAC) apesar do nome do header —
// a doc oficial descreve literalmente sha256(body BRUTO concatenado com o secret), sem
// formatar o JSON antes do cálculo. ZapSign segue com HMAC-SHA256 genérico (key=secret) até
// haver confirmação real do esquema.
function computeClicksignSignatureHex(secret, rawBody) {
  return crypto.createHash('sha256').update(Buffer.concat([rawBody, Buffer.from(secret, 'utf8')])).digest('hex');
}
function computeHmacSha256Hex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * verifyProviderWebhookSignature — compara a assinatura do corpo BRUTO da requisição com o
 * valor recebido no header do provedor, usando `crypto.timingSafeEqual` — NUNCA comparação
 * direta de string (`===`), que vazaria timing e permitiria um ataque de força bruta byte a
 * byte sobre a assinatura esperada. `timingSafeEqual` exige buffers do mesmo tamanho, então
 * checamos o tamanho primeiro (uma incompatibilidade de tamanho já é "inválido").
 */
function verifyProviderWebhookSignature(provider, rawBody, headers, webhookSecret) {
  const headerName = WEBHOOK_HEADER_BY_PROVIDER[provider];
  if (!headerName || !webhookSecret || !rawBody || rawBody.length === 0) return false;

  const received = headers ? headers[headerName] : null;
  if (!received || typeof received !== 'string') return false;
  const receivedHex = received.startsWith('sha256=') ? received.slice('sha256='.length) : received;

  const expectedHex = provider === 'clicksign' ? computeClicksignSignatureHex(webhookSecret, rawBody) : computeHmacSha256Hex(webhookSecret, rawBody);

  let expectedBuffer;
  let receivedBuffer;
  try {
    expectedBuffer = Buffer.from(expectedHex, 'hex');
    receivedBuffer = Buffer.from(receivedHex, 'hex');
  } catch (err) {
    return false;
  }

  const isValid = expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

  // DEBUG TEMPORÁRIO (remover após confirmar a fórmula real do Clicksign, achado divergente em
  // 19/09/2026: eventos reais "sign"/"signature_started" davam LEGAL_WEBHOOK_HMAC_INVALID).
  // Loga o hex recebido e TODAS as variantes de fórmula candidatas — nunca o secret em si —
  // pra comparar no log e descobrir qual bate, sem reduzir a segurança da verificação real.
  if (provider === 'clicksign' && !isValid) {
    const bodyPlusSecret = crypto.createHash('sha256').update(Buffer.concat([rawBody, Buffer.from(webhookSecret, 'utf8')])).digest('hex');
    const secretPlusBody = crypto.createHash('sha256').update(Buffer.concat([Buffer.from(webhookSecret, 'utf8'), rawBody])).digest('hex');
    const hmacKeySecret = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      debugClicksignHmac: true,
      receivedHex,
      candidates: { bodyPlusSecret, secretPlusBody, hmacKeySecret },
      matches: {
        bodyPlusSecret: bodyPlusSecret === receivedHex,
        secretPlusBody: secretPlusBody === receivedHex,
        hmacKeySecret: hmacKeySecret === receivedHex,
      },
      bodyLength: rawBody.length,
    }));
  }

  return isValid;
}

const signatureWebhook = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction(async (t) => {
    const tenant = { groupId: req.auth.groupId, companyId: req.auth.companyId };
    const provider = await getSetting('legal.signature_provider', tenant, t, 'sandbox');

    // Regra crítica: se um provedor real estiver configurado para o tenant, a rota DEVE
    // rejeitar qualquer payload sem HMAC válido — nunca aplica o webhook "por confiança". O
    // sandbox (sem provedor real por trás) segue sem exigir HMAC.
    if (provider === 'clicksign' || provider === 'zapsign') {
      const webhookSecretKey = WEBHOOK_SECRET_SETTING_BY_PROVIDER[provider];
      const webhookSecret = await getDecryptedSetting(webhookSecretKey, tenant, t, null);
      const rawBody = req.rawBody;
      const isValid = verifyProviderWebhookSignature(provider, rawBody, req.headers, webhookSecret);
      if (!isValid) {
        throw AppError.unauthorized(
          'Assinatura HMAC do webhook ausente ou inválida para o provedor configurado.',
          'LEGAL_WEBHOOK_HMAC_INVALID'
        );
      }
    }

    return signaturesService.handleSignatureWebhook(req.params.externalSignatureId, req.body, t);
  });
  return success(res, { data: result });
});

/**
 * clicksignPublicWebhook — endpoint PÚBLICO de verdade (fora do authMiddleware/tenantMiddleware
 * — ver legal.routes.js), o único que o Clicksign de fato consegue chamar, já que o provedor
 * externo não tem (e nunca terá) um JWT de usuário deste sistema.
 *
 * Fluxo (ver migration 20260101000172-create-legal-signature_provider_routing e a nota em
 * signatures.service.js): extrai a "key" do signatário do payload do evento (formato
 * confirmado contra a documentação oficial: `event.data.signer.key`), resolve group_id/
 * company_id na tabela de roteamento (SEM RLS, só ids opacos), e SÓ DEPOIS abre a transação
 * com `SET LOCAL` de tenant para validar o HMAC (segredo é por-tenant) e aplicar o webhook.
 * Eventos que não são "sign" (ex.: refusal, cancel) são reconhecidos com 200 mas não têm
 * efeito hoje — o domínio (handleSignatureWebhook) só sabe processar confirmação de assinatura;
 * tratá-los é trabalho futuro, não parte deste marco.
 */
const clicksignPublicWebhook = catchAsync(async (req, res) => {
  const eventName = req.body && req.body.event && req.body.event.name;
  const signerKey = req.body && req.body.event && req.body.event.data && req.body.event.data.signer && req.body.event.data.signer.key;

  if (!signerKey) {
    // Evento sem signatário (ex.: upload, add_image) — reconhece sem processar.
    return success(res, { data: { acknowledged: true, processed: false, reason: 'no_signer_key' } });
  }

  const routing = await SignatureProviderRouting.findOne({ where: { externalSignatureId: signerKey } });
  if (!routing) {
    // Assinatura desconhecida (de outro ambiente/conta, ou nunca solicitada por aqui) — 200
    // para o Clicksign não ficar reenviando, mas não processa nada.
    return success(res, { data: { acknowledged: true, processed: false, reason: 'unknown_signer' } });
  }

  const tenant = { groupId: routing.groupId, companyId: routing.companyId };
  const rawBody = req.rawBody;

  const result = await sequelize.transaction(async (t) => {
    await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: tenant.groupId }, transaction: t });
    await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId: tenant.companyId }, transaction: t });

    const webhookSecret = await getDecryptedSetting('legal.clicksign_webhook_secret', tenant, t, null);
    const isValid = verifyProviderWebhookSignature('clicksign', rawBody, req.headers, webhookSecret);
    if (!isValid) {
      throw AppError.unauthorized(
        'Assinatura do webhook (Content-Hmac) ausente ou inválida.',
        'LEGAL_WEBHOOK_HMAC_INVALID'
      );
    }

    if (eventName !== 'sign') {
      return { acknowledged: true, processed: false, reason: `event_${eventName}_not_handled` };
    }

    const applied = await signaturesService.handleSignatureWebhook(signerKey, req.body, t);
    return { acknowledged: true, processed: true, ...applied };
  });

  return success(res, { data: result });
});

const checkSignatureStatus = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => signaturesService.checkSignatureStatus(req.params.id, t));
  return success(res, { data: result });
});

const cancelSignature = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => signaturesService.cancelSignature(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Guarantees ---
const createGuarantee = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteesService.createGuarantee(req.params.contractId, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listGuarantees = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    guaranteesService.listGuarantees(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getGuarantee = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteesService.getGuarantee(req.params.id, t));
  return success(res, { data: item });
});
const updateGuarantee = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => guaranteesService.updateGuarantee(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const removeGuarantee = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) => guaranteesService.deleteGuarantee(req.params.id, req.auth.userId, t));
  return success(res, { data: result });
});

// --- Inspections ---
const createInspection = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.createInspection(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listInspections = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    inspectionsService.listInspections(t, {
      propertyId: req.query.propertyId,
      contractId: req.query.contractId,
      status: req.query.status,
      inspectionType: req.query.inspectionType,
    })
  );
  return success(res, { data: items });
});
const getInspection = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.getInspection(req.params.id, t));
  return success(res, { data: item });
});
const completeInspection = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.completeInspection(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});
const addInspectionItem = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => inspectionsService.addInspectionItem(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listInspectionItems = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => inspectionsService.listInspectionItems(req.params.id, t));
  return success(res, { data: items });
});
const compareInspections = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    inspectionsService.compareInspections(req.query.entryInspectionId, req.query.exitInspectionId, t)
  );
  return success(res, { data: result });
});
const attachInspectionItemMedia = catchAsync(async (req, res) => {
  const link = await req.withTenantTransaction((t) =>
    inspectionsService.attachInspectionItemMedia(req.params.itemId, req.body, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: link });
});
const listInspectionItemMedia = catchAsync(async (req, res) => {
  const links = await req.withTenantTransaction((t) => inspectionsService.listInspectionItemMedia(req.params.itemId, t));
  return success(res, { data: links });
});
const signInspection = catchAsync(async (req, res) => {
  const signature = await req.withTenantTransaction((t) =>
    inspectionsService.signInspection(req.params.id, req.body, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: signature });
});
const listInspectionSignatures = catchAsync(async (req, res) => {
  const signatures = await req.withTenantTransaction((t) => inspectionsService.listInspectionSignatures(req.params.id, t));
  return success(res, { data: signatures });
});
const generateInspectionReport = catchAsync(async (req, res) => {
  const result = await req.withTenantTransaction((t) =>
    inspectionsService.generateInspectionReport(req.params.id, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: result });
});
const getInspectionReport = catchAsync(async (req, res) => {
  const { pdfBytes, reportHash } = await req.withTenantTransaction((t) => inspectionsService.getInspectionReport(req.params.id, t));
  res.set('Content-Type', 'application/pdf');
  res.set('X-Report-Sha256', reportHash);
  res.set('Content-Disposition', `attachment; filename="vistoria-${req.params.id}.pdf"`);
  return res.status(200).send(pdfBytes);
});

// --- Key deliveries ---
const createKeyDelivery = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => keyDeliveriesService.createKeyDelivery(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listKeyDeliveries = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    keyDeliveriesService.listKeyDeliveries(t, { contractId: req.query.contractId, status: req.query.status })
  );
  return success(res, { data: items });
});
const getKeyDelivery = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => keyDeliveriesService.getKeyDelivery(req.params.id, t));
  return success(res, { data: item });
});
const releaseKeyDelivery = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => keyDeliveriesService.releaseKeyDelivery(req.params.id, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Legal cases ---
const createLegalCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.createLegalCase(withTenant(req), req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listLegalCases = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    legalCasesService.listLegalCases(t, { status: req.query.status, caseType: req.query.caseType, contractId: req.query.contractId })
  );
  return success(res, { data: items });
});
const getLegalCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.getLegalCase(req.params.id, t));
  return success(res, { data: item });
});
const updateLegalCase = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.updateLegalCase(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});
const linkCaseToTask = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalCasesService.linkCaseToTask(req.params.id, req.body.taskId, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Legal deadlines ---
const createLegalDeadline = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalDeadlinesService.createLegalDeadline(req.params.id, req.body, req.auth.userId, t));
  return success(res, { statusCode: 201, data: item });
});
const listLegalDeadlines = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) =>
    legalDeadlinesService.listLegalDeadlines(t, { legalCaseId: req.query.legalCaseId, status: req.query.status, severity: req.query.severity })
  );
  return success(res, { data: items });
});
const updateLegalDeadline = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => legalDeadlinesService.updateLegalDeadline(req.params.id, req.body, req.auth.userId, t));
  return success(res, { data: item });
});

// --- Evidence packages ---
const createEvidencePackage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    evidencePackagesService.createEvidencePackage(req.params.id, req.body.manifestItems, req.auth.userId, t)
  );
  return success(res, { statusCode: 201, data: item });
});
const listEvidencePackages = catchAsync(async (req, res) => {
  const items = await req.withTenantTransaction((t) => evidencePackagesService.listEvidencePackages(req.params.id, t));
  return success(res, { data: items });
});
// M5-28: o acesso HUMANO ao dossiê entra na cadeia de custódia (viewEvidencePackage), ao
// contrário de getEvidencePackage, que é a leitura interna usada por outros fluxos.
const getEvidencePackage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) =>
    evidencePackagesService.viewEvidencePackage(req.params.id, req.auth.userId, t)
  );
  return success(res, { data: item });
});

// M5-29: export autocontido e verificável do dossiê (registra EXPORTED na cadeia de custódia).
const exportEvidencePackage = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) =>
    evidencePackagesService.exportEvidencePackage(req.params.id, req.auth.userId, t)
  );
  return success(res, { data });
});

const listEvidencePackageAccessLog = catchAsync(async (req, res) => {
  const data = await req.withTenantTransaction((t) => evidencePackagesService.listEvidenceAccessLog(req.params.id, t));
  return success(res, { data });
});

module.exports = {
  createContract, listContracts, getContract, transitionContract, addContractParty, listContractParties, correctContractData,
  createContractVersion, listContractVersions,
  initiateSignature, listSignaturesByContractVersion, signatureWebhook, clicksignPublicWebhook, verifyProviderWebhookSignature,
  checkSignatureStatus, cancelSignature,
  createGuarantee, listGuarantees, getGuarantee, updateGuarantee, removeGuarantee,
  createInspection, listInspections, getInspection, completeInspection, addInspectionItem, listInspectionItems, compareInspections,
  attachInspectionItemMedia, listInspectionItemMedia, signInspection, listInspectionSignatures, generateInspectionReport, getInspectionReport,
  createKeyDelivery, listKeyDeliveries, getKeyDelivery, releaseKeyDelivery,
  createLegalCase, listLegalCases, getLegalCase, updateLegalCase, linkCaseToTask,
  createLegalDeadline, listLegalDeadlines, updateLegalDeadline,
  createEvidencePackage, listEvidencePackages, getEvidencePackage, exportEvidencePackage, listEvidencePackageAccessLog,
};
