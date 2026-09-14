'use strict';

const crypto = require('crypto');
const catchAsync = require('../../utils/catchAsync');
const { success } = require('../../utils/httpResponse');
const AppError = require('../../utils/AppError');
const { getSetting, getDecryptedSetting } = require('../settings/settings.service');
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
// Webhook de assinatura — DECISÃO DE ENGENHARIA: um webhook de provedor real chegaria SEM
// JWT de usuário (é o provedor externo chamando, autenticado por segredo/HMAC próprio), e
// precisaria resolver group_id/company_id a partir do próprio Signature antes de aplicar
// RLS. Enquanto não existir uma rota pública dedicada fora do router autenticado, esta rota
// continua atrás do MESMO authMiddleware/tenantMiddleware das demais rotas de legal (exige
// "legal:sign") — ou seja, ela é chamada como uma ação autenticada que recebe/valida o
// webhook, não como endpoint público de fato. Agora que existem provedores reais
// (Clicksign/ZapSign) configuráveis via settings, a rota EXIGE HMAC válido do corpo bruto
// sempre que o tenant tiver um provider real configurado — só o sandbox (sem provedor real
// por trás) segue sem exigir HMAC, pois não há segredo de webhook para validar contra.

const WEBHOOK_HEADER_BY_PROVIDER = {
  // DECISÃO DE ENGENHARIA — validar contra documentação oficial atualizada de cada provedor
  // antes de produção: nome exato do header de assinatura do webhook (e se é HMAC hex, base64,
  // ou vem com prefixo tipo "sha256=") pode ter mudado desde a última verificação.
  clicksign: 'x-clicksign-signature',
  zapsign: 'x-zapsign-signature',
};

const WEBHOOK_SECRET_SETTING_BY_PROVIDER = {
  clicksign: 'legal.clicksign_webhook_secret',
  zapsign: 'legal.zapsign_webhook_secret',
};

function computeHmacSha256Hex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * verifyProviderWebhookSignature — compara o HMAC-SHA256 (hex) do corpo BRUTO da requisição
 * com o valor recebido no header do provedor, usando `crypto.timingSafeEqual` — NUNCA
 * comparação direta de string (`===`), que vazaria timing e permitiria um ataque de força
 * bruta byte a byte sobre a assinatura esperada. `timingSafeEqual` exige buffers do mesmo
 * tamanho, então checamos o tamanho primeiro (uma incompatibilidade de tamanho já é
 * "inválido", sem precisar comparar byte a byte).
 *
 * DECISÃO DE ENGENHARIA — validar contra documentação oficial atualizada de cada provedor
 * antes de produção: assumimos aqui o mesmo esquema (HMAC-SHA256 hex do corpo bruto) para
 * Clicksign e ZapSign; cada provedor pode ter particularidades (ex.: incluir timestamp no
 * cálculo, usar outro digest) que só são confirmáveis com credencial/documentação real.
 */
function verifyProviderWebhookSignature(provider, rawBody, headers, webhookSecret) {
  const headerName = WEBHOOK_HEADER_BY_PROVIDER[provider];
  if (!headerName || !webhookSecret || !rawBody || rawBody.length === 0) return false;

  const received = headers ? headers[headerName] : null;
  if (!received || typeof received !== 'string') return false;

  let expectedBuffer;
  let receivedBuffer;
  try {
    expectedBuffer = Buffer.from(computeHmacSha256Hex(webhookSecret, rawBody), 'hex');
    receivedBuffer = Buffer.from(received, 'hex');
  } catch (err) {
    return false;
  }

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
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
const getEvidencePackage = catchAsync(async (req, res) => {
  const item = await req.withTenantTransaction((t) => evidencePackagesService.getEvidencePackage(req.params.id, t));
  return success(res, { data: item });
});

module.exports = {
  createContract, listContracts, getContract, transitionContract, addContractParty, listContractParties, correctContractData,
  createContractVersion, listContractVersions,
  initiateSignature, listSignaturesByContractVersion, signatureWebhook, verifyProviderWebhookSignature,
  checkSignatureStatus, cancelSignature,
  createGuarantee, listGuarantees, getGuarantee, updateGuarantee, removeGuarantee,
  createInspection, listInspections, getInspection, completeInspection, addInspectionItem, listInspectionItems, compareInspections,
  attachInspectionItemMedia, listInspectionItemMedia, signInspection, listInspectionSignatures, generateInspectionReport, getInspectionReport,
  createKeyDelivery, listKeyDeliveries, getKeyDelivery, releaseKeyDelivery,
  createLegalCase, listLegalCases, getLegalCase, updateLegalCase, linkCaseToTask,
  createLegalDeadline, listLegalDeadlines, updateLegalDeadline,
  createEvidencePackage, listEvidencePackages, getEvidencePackage,
};
