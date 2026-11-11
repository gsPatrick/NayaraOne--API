'use strict';

const crypto = require('crypto');
const { KeyDelivery, Inspection, ContractParty } = require('../../../models');
const { resolveKeyDeliveryPhotoPolicy, assertPhotoPolicy } = require('./keyDeliveryPhotos');
const { assertDeliveryGuarantees } = require('./keyDeliveryGuarantees');
const { deliveryInspectionTypes, resolveDeliveryInspection } = require('./keyDeliveryInspection');
const { assertKeyDeliveryRequirements, resolveTermEvidence } = require('./keyDeliveryGates');
const { assertUuid, assertText } = require('../../../utils/inputGuards');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishKeyDeliveryReleased, publishKeysDelivered } = require('../shared/legalEvents.service');
const { getContract } = require('../contracts/application/contract.service');

// Caderno Anexo I "3. Tipos de contrato": termos específicos de entrega — KEY_DELIVERY (entrega
// de chaves padrão) e USED_PROPERTY_DELIVERY (entrega de imóvel usado, termo específico
// deixando clara a natureza/estado do imóvel — ver "7. Checklist documental").
const TERM_TYPES = ['KEY_DELIVERY', 'USED_PROPERTY_DELIVERY'];

// Frente 5 (conferência 18/10/2026 item 11 — bug real): a política de fotos ("photosRequired") e o termo vinham do
// PAYLOAD. Agora a POLÍTICA é decidida pelo servidor (keyDeliveryPhotos.js: configuração da empresa por tipo de contrato,
// com quantidade mínima), o TERMO é texto gerado pelo servidor com hash SHA-256 gravado e campos de política/termo enviados
// pelo cliente são REJEITADOS (400), não ignorados.
const CLIENT_FORBIDDEN_FIELDS = ['photosRequired', 'photoPolicy', 'termText', 'termVersion', 'termHash', 'policy'];


const {
  KEY_DELIVERY_TERM_VERSION, KEY_DELIVERY_TERM_VERSION_V1, buildKeyDeliveryTermV1, buildKeyDeliveryTermV2, gatherTermV2Context, formatTaxId,
} = require('./keyDeliveryTerm');

// F6 (auditoria M45, 19/10/2026): recebedor e signatário aceitavam QUALQUER pessoa da base.
// O Caderno M5 §10 não prevê procurador/terceiro autorizado na entrega de chaves — então ambos
// precisam ser PARTE do contrato (legal.contract_parties). Erro 400 com código próprio.
async function assertContractParty(contractId, personId, transaction, { code, message }) {
  const party = await ContractParty.findOne({ where: { contractId, personId }, transaction });
  if (!party) throw AppError.badRequest(message, code);
  return party;
}
const RECIPIENT_NOT_PARTY = {
  code: 'LEGAL_KEY_DELIVERY_RECIPIENT_NOT_PARTY',
  message: 'O recebedor das chaves precisa ser uma parte do contrato (cadastre-o em Partes do contrato antes).',
};
const SIGNER_NOT_PARTY = {
  code: 'LEGAL_KEY_DELIVERY_TERM_SIGNER_INVALID',
  message: 'O termo de entrega precisa ser assinado por uma parte do contrato.',
};

async function createKeyDelivery(payload, actorUserId, transaction) {
  const { groupId, companyId, contractId, inspectionId, deliveredToPersonId, notes, termType } = payload;
  if (!groupId || !companyId || !contractId || !deliveredToPersonId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "contractId" e "deliveredToPersonId" são obrigatórios.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  if (termType !== undefined && termType !== null && !TERM_TYPES.includes(termType)) {
    throw AppError.badRequest(`"termType" deve ser um de: ${TERM_TYPES.join(', ')}.`, 'LEGAL_KEY_DELIVERY_VALIDATION');
  }
  // Fechamento M5 (pentest): ids com tipo errado (ex.: objeto) e texto longo viram 400, nunca 500.
  assertUuid(contractId, 'contractId', 'LEGAL_KEY_DELIVERY_VALIDATION');
  assertUuid(deliveredToPersonId, 'deliveredToPersonId', 'LEGAL_KEY_DELIVERY_VALIDATION');
  assertUuid(inspectionId, 'inspectionId', 'LEGAL_KEY_DELIVERY_VALIDATION', { optional: true });
  assertText(notes, 'notes', 2000, 'LEGAL_KEY_DELIVERY_VALIDATION');

  // ADV (M5-32): o contrato NUNCA era carregado na criação — quem chamasse o service com o
  // UUID de um contrato de outra empresa e o próprio group/company no payload conseguia criar
  // uma entrega de chaves apontando para um contrato que não pode nem ler. `getContract` roda
  // sob o RLS do tenant do chamador, então um contrato de outro tenant simplesmente não existe
  // aqui (404) — e o group/company gravados passam a vir do CONTRATO, não do payload, para que
  // um payload forjado não consiga plantar a linha no tenant errado.
  const contract = await getContract(contractId, transaction);
  await assertContractParty(contract.id, deliveredToPersonId, transaction, RECIPIENT_NOT_PARTY);
  if (inspectionId && !(await Inspection.findOne({ where: { id: inspectionId, contractId: contract.id }, attributes: ['id'], transaction }))) {
    throw AppError.badRequest('A vistoria informada não é deste contrato.', 'LEGAL_KEY_DELIVERY_INSPECTION_OTHER_CONTRACT');
  }

  const keyDelivery = await KeyDelivery.create(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      contractId,
      inspectionId: inspectionId || null,
      deliveredToPersonId,
      deliveredByUserId: null,
      deliveredAt: null,
      status: 'PENDING',
      notes: notes || null,
      // FIX (ciclo cético Marco 5): a coluna já existe (migration 20260101000290) e agora está
      // declarada no model — persistida direto na criação, não mais via atribuição pós-create
      // sem save() (que nunca gravava nada de fato).
      termType: termType || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId: contract.groupId,
      companyId: contract.companyId,
      actorUserId,
      action: 'legal.key_delivery.create',
      entityType: 'KeyDelivery',
      entityId: keyDelivery.id,
      afterJson: keyDelivery.toJSON(),
      reason: `Entrega de chaves registrada como PENDING para o contrato ${contractId}.`,
    },
    transaction
  );

  return keyDelivery;
}

async function listKeyDeliveries(transaction, filters = {}) {
  const where = {};
  if (filters.contractId) where.contractId = filters.contractId;
  if (filters.status) where.status = String(filters.status).toUpperCase();
  return KeyDelivery.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getKeyDelivery(id, transaction) {
  const keyDelivery = await KeyDelivery.findByPk(id, { transaction });
  if (!keyDelivery) throw AppError.notFound('Entrega de chaves não encontrada.', 'LEGAL_KEY_DELIVERY_NOT_FOUND');
  return keyDelivery;
}

/**
 * F7 (auditoria M45): prévia do termo KD-TERM-v1 gerado pelo servidor, ANTES de liberar (com os
 * valores que o usuário está preenchendo) — não grava nada. Depois de liberado devolve o termo
 * gravado (texto + hash). Não aplica os gates de liberação: é só leitura.
 */
async function previewKeyDeliveryTerm(id, query, transaction) {
  const keyDelivery = await getKeyDelivery(id, transaction);
  if (keyDelivery.status === 'RELEASED' && keyDelivery.termText) {
    return {
      preview: false,
      termVersion: keyDelivery.termVersion,
      termText: keyDelivery.termText,
      termHash: keyDelivery.termHash,
      photoPolicy: keyDelivery.photoPolicy,
    };
  }
  const contract = await getContract(keyDelivery.contractId, transaction);
  const q = query || {};
  let checkIn = null;
  const where = keyDelivery.inspectionId
    ? { id: keyDelivery.inspectionId, contractId: contract.id, inspectionType: deliveryInspectionTypes(contract), status: 'COMPLETED' }
    : { contractId: contract.id, inspectionType: deliveryInspectionTypes(contract), status: 'COMPLETED' };
  checkIn = await Inspection.findOne({ where, order: [['created_at', 'DESC']], transaction });
  const policy = await resolveKeyDeliveryPhotoPolicy(contract, keyDelivery, transaction);
  const n = Number(q.keysCount);
  const signerId = /^[0-9a-f-]{36}$/i.test(String(q.termSignedByPersonId || '')) ? q.termSignedByPersonId : null;
  const ctx = await gatherTermV2Context({ contract, keyDelivery, termSignedByPersonId: signerId, checkIn }, transaction);
  const termText = buildKeyDeliveryTermV2({
    contract,
    keyDelivery,
    keysCount: Number.isFinite(n) && n > 0 ? n : null,
    keysIdentification: q.keysIdentification ? String(q.keysIdentification).slice(0, 500) : null,
    checkIn,
    policy,
    signedAt: null,
    ctx,
  });
  return { preview: true, termVersion: KEY_DELIVERY_TERM_VERSION, termText, termHash: null, photoPolicy: policy.code, photosRequired: policy.photosRequired, minPhotos: policy.minPhotos };
}

/**
 * releaseKeyDelivery — TRAVA de negócio: só libera se o Contract estiver em SIGNED/ACTIVE E
 * existir uma Inspection CHECK_IN COMPLETED para o mesmo contrato (ou, na ausência de
 * contract_id na vistoria, para o mesmo imóvel do contrato — contratos de venda podem ter
 * vistorias sem vínculo direto, mas o caso de uso central aqui é locação).
 */
// `options.deliveredAt` (só de chamador interno, nunca do corpo da requisição): data real da entrega quando o fato aconteceu antes do registro, como a importação do formulário
// de contingência em papel (M9-D832). Sem ela vale o instante da liberação. Todas as travas continuam valendo.
async function releaseKeyDelivery(id, payload, actorUserId, transaction, options = {}) {
  const keyDelivery = await getKeyDelivery(id, transaction);
  if (keyDelivery.status === 'RELEASED') {
    throw AppError.conflict('Entrega de chaves já foi liberada.', 'LEGAL_KEY_DELIVERY_ALREADY_RELEASED');
  }
  if (keyDelivery.status === 'CANCELLED') {
    throw AppError.conflict('Entrega de chaves cancelada não pode ser liberada.', 'LEGAL_KEY_DELIVERY_CANCELLED');
  }

  const contract = await getContract(keyDelivery.contractId, transaction);
  if (!['SIGNED', 'ACTIVE'].includes(contract.status)) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: contrato precisa estar assinado/ativo e a vistoria de entrada concluída.',
      'LEGAL_KEY_DELIVERY_BLOCKED'
    );
  }
  // Caderno §10 "Exigir documentos e garantias válidos" (keyDeliveryGuarantees.js): garantia válida de verdade quando o
  // contrato a exige; com garantia cadastrada, ao menos uma ativa e dentro da vigência.
  await assertDeliveryGuarantees(contract, transaction);

  // Fechamento M5 (3ª rodada): os dados do pedido e a via assinada do termo são conferidos ANTES da vistoria, para a
  // pessoa saber de uma vez o que falta no próprio pedido; a vistoria e o checklist vêm depois.
  // Caderno Anexo I "10. Entrega de chaves": "Registrar quantidade/identificação de
  // chaves/controles", "Fotos obrigatórias quando política exigir", "Assinatura do termo de
  // entrega." Fail closed: exige quantidade E assinatura do termo (pessoa que coletou/assinou)
  // sempre — fotos só quando `photosRequired` (política) estiver marcada.
  const body = payload || {};
  const forbidden = CLIENT_FORBIDDEN_FIELDS.filter((f) => body[f] !== undefined);
  if (forbidden.length > 0) {
    throw AppError.badRequest(
      `Política de fotos e termo de entrega são definidos pelo servidor — não envie: ${forbidden.join(', ')}.`,
      'LEGAL_KEY_DELIVERY_SERVER_POLICY'
    );
  }
  const { keysCount, keysIdentification, photosFileIds, termSignedByPersonId, termEvidenceFileId } = body;
  const policy = await resolveKeyDeliveryPhotoPolicy(contract, keyDelivery, transaction);
  const photosRequired = policy.photosRequired;
  assertUuid(termSignedByPersonId, 'termSignedByPersonId', 'LEGAL_KEY_DELIVERY_VALIDATION', { optional: true });
  assertText(keysIdentification, 'keysIdentification', 500, 'LEGAL_KEY_DELIVERY_VALIDATION');
  if (keysCount === undefined || keysCount === null || typeof keysCount === 'object' || !Number.isInteger(Number(keysCount)) || Number(keysCount) <= 0) {
    throw AppError.badRequest(
      '"keysCount" (quantidade de chaves/controles entregues) é obrigatório e deve ser maior que zero.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  // Caderno §10 "Registrar quantidade/identificação de chaves/controles": a identificação também é obrigatória.
  if (typeof keysIdentification !== 'string' || !keysIdentification.trim()) {
    throw AppError.badRequest(
      '"keysIdentification" (identificação das chaves/controles entregues, por exemplo "2 chaves da porta + 1 controle do portão") é obrigatória.',
      'LEGAL_KEY_DELIVERY_IDENTIFICATION_REQUIRED'
    );
  }
  if (!termSignedByPersonId) {
    throw AppError.badRequest(
      '"termSignedByPersonId" é obrigatório — a liberação de chaves exige assinatura do termo de entrega.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  await assertPhotoPolicy(policy, photosFileIds, contract, transaction);

  // Recebedor (entregas antigas, criadas antes da regra F6) e signatário precisam ser partes.
  await assertContractParty(contract.id, keyDelivery.deliveredToPersonId, transaction, RECIPIENT_NOT_PARTY);
  await assertContractParty(contract.id, termSignedByPersonId, transaction, SIGNER_NOT_PARTY);
  const termEvidence = await resolveTermEvidence(termEvidenceFileId, contract, transaction);
  const checkIn = await resolveDeliveryInspection(keyDelivery, contract, transaction);

  // Fechamento M5 (Caderno §10 "Checklist calculado por Motor de Regras"/"Exigir documentos"; Guia §11): checklist da
  // etapa KEY_DELIVERY reconferido depois de contrato, garantia e vistoria (que têm mensagem própria).
  await assertKeyDeliveryRequirements(contract.id, transaction);

  const signedAt = new Date();
  const ctx = await gatherTermV2Context({ contract, keyDelivery, termSignedByPersonId, checkIn }, transaction);
  const termText = buildKeyDeliveryTermV2({
    contract,
    keyDelivery,
    keysCount: Number(keysCount),
    keysIdentification: keysIdentification.trim(),
    checkIn,
    policy,
    signedAt,
    ctx,
  });

  const beforeJson = keyDelivery.toJSON();
  keyDelivery.status = 'RELEASED';
  keyDelivery.deliveredAt = options && options.deliveredAt ? new Date(options.deliveredAt) : new Date();
  keyDelivery.deliveredByUserId = actorUserId || null;
  keyDelivery.updatedBy = actorUserId || null;
  // FIX (ciclo cético Marco 5): a coluna já existe (migration 20260101000290) e agora está
  // declarada no model — `save()` abaixo persiste de verdade, antes ficava só em memória.
  keyDelivery.keysCount = Number(keysCount);
  keyDelivery.keysIdentification = keysIdentification.trim();
  keyDelivery.photosRequired = Boolean(photosRequired);
  keyDelivery.photosFileIds = Array.isArray(photosFileIds) ? photosFileIds : null;
  keyDelivery.termSignedByPersonId = termSignedByPersonId;
  Object.assign(keyDelivery, termEvidence);
  keyDelivery.termSignedAt = signedAt;
  keyDelivery.termText = termText;
  keyDelivery.termVersion = KEY_DELIVERY_TERM_VERSION;
  keyDelivery.termHash = crypto.createHash('sha256').update(termText, 'utf8').digest('hex');
  keyDelivery.photoPolicy = policy.code;
  await keyDelivery.save({ transaction });

  await publishKeyDeliveryReleased(keyDelivery, transaction);
  await publishKeysDelivered(keyDelivery, transaction);

  await registrarAuditoria(
    {
      groupId: keyDelivery.groupId,
      companyId: keyDelivery.companyId,
      actorUserId,
      action: 'legal.key_delivery.release',
      entityType: 'KeyDelivery',
      entityId: keyDelivery.id,
      beforeJson,
      afterJson: keyDelivery.toJSON(),
      reason: `Chaves do contrato ${contract.id} liberadas.`,
    },
    transaction
  );

  return keyDelivery;
}

/**
 * cancelKeyDelivery — M45: encerra uma entrega PENDING (ex.: criada antes da regra F6 com
 * recebedor que não é parte do contrato). Motivo obrigatório; nada é apagado; auditado.
 */
async function cancelKeyDelivery(id, payload, actorUserId, transaction) {
  const reason = String((payload && payload.reason) || '').trim();
  if (reason.length < 5) {
    throw AppError.badRequest('Informe o motivo do cancelamento (mínimo de 5 caracteres).', 'LEGAL_KEY_DELIVERY_CANCEL_REASON_REQUIRED');
  }
  const keyDelivery = await KeyDelivery.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!keyDelivery) throw AppError.notFound('Entrega de chaves não encontrada.', 'LEGAL_KEY_DELIVERY_NOT_FOUND');
  if (keyDelivery.status !== 'PENDING') {
    throw AppError.conflict(
      keyDelivery.status === 'RELEASED'
        ? 'Entrega de chaves já liberada não pode ser cancelada — o termo assinado é definitivo.'
        : 'Esta entrega de chaves já está cancelada.',
      'LEGAL_KEY_DELIVERY_INVALID_STATUS'
    );
  }
  const beforeJson = keyDelivery.toJSON();
  keyDelivery.status = 'CANCELLED';
  keyDelivery.cancelledAt = new Date();
  keyDelivery.cancelledBy = actorUserId || null;
  keyDelivery.cancelReason = reason.slice(0, 2000);
  keyDelivery.updatedBy = actorUserId || null;
  await keyDelivery.save({ transaction });
  await registrarAuditoria(
    {
      groupId: keyDelivery.groupId,
      companyId: keyDelivery.companyId,
      actorUserId,
      action: 'legal.key_delivery.cancel',
      entityType: 'KeyDelivery',
      entityId: keyDelivery.id,
      beforeJson,
      afterJson: keyDelivery.toJSON(),
      reason: `Entrega de chaves cancelada. Motivo: ${keyDelivery.cancelReason}`,
    },
    transaction
  );
  return keyDelivery;
}

module.exports = {
  createKeyDelivery,
  listKeyDeliveries,
  getKeyDelivery,
  releaseKeyDelivery,
  previewKeyDeliveryTerm,
  resolveKeyDeliveryPhotoPolicy,
  cancelKeyDelivery,
  buildKeyDeliveryTermV1,
  buildKeyDeliveryTermV2,
  formatTaxId,
  KEY_DELIVERY_TERM_VERSION,
  KEY_DELIVERY_TERM_VERSION_V1,
};
