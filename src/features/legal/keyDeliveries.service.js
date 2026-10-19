'use strict';

const crypto = require('crypto');
const { KeyDelivery, Inspection, InspectionSignature, Guarantee, ContractParty, Person } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { publishKeyDeliveryReleased, publishKeysDelivered } = require('./legalEvents.service');
const { getContract, isSaleLikeContractType } = require('./contracts.service');

// Caderno Anexo I "3. Tipos de contrato": termos específicos de entrega — KEY_DELIVERY (entrega
// de chaves padrão) e USED_PROPERTY_DELIVERY (entrega de imóvel usado, termo específico
// deixando clara a natureza/estado do imóvel — ver "7. Checklist documental").
const TERM_TYPES = ['KEY_DELIVERY', 'USED_PROPERTY_DELIVERY'];

// Frente 5 (conferência 18/10/2026 item 11 — bug real): a política de fotos ("photosRequired") e
// o termo vinham do PAYLOAD — o cliente decidia se foto era obrigatória e nada do termo era
// gerado pelo servidor. Agora:
//  - POLÍTICA: decidida aqui, pelo tipo de termo e de contrato. Entrega de imóvel usado e
//    entrega de imóvel vendido (casa nova — checklist "Fotos" do Caderno §7) exigem fotos;
//    locação já tem a vistoria de entrada assinada com mídia e não exige foto extra.
//  - TERMO: texto gerado pelo servidor a partir de um modelo versionado, com hash SHA-256 gravado.
//  - Campos de política/termo enviados pelo cliente são REJEITADOS (400), não ignorados.
const KEY_DELIVERY_TERM_VERSION = 'KD-TERM-v1';
const CLIENT_FORBIDDEN_FIELDS = ['photosRequired', 'photoPolicy', 'termText', 'termVersion', 'termHash', 'policy'];

function resolveKeyDeliveryPhotoPolicy(contract, keyDelivery) {
  if (keyDelivery.termType === 'USED_PROPERTY_DELIVERY') return { code: 'REQUIRED_USED_PROPERTY', photosRequired: true };
  if (isSaleLikeContractType(contract.contractType)) return { code: 'REQUIRED_SALE_DELIVERY', photosRequired: true };
  return { code: 'NOT_REQUIRED_LEASE_CHECKIN_SIGNED', photosRequired: false };
}

function buildKeyDeliveryTerm({ contract, keyDelivery, keysCount, keysIdentification, signerName, recipientName, checkIn, policy, signedAt }) {
  const title = keyDelivery.termType === 'USED_PROPERTY_DELIVERY'
    ? 'TERMO DE ENTREGA DE IMÓVEL USADO E CHAVES'
    : 'TERMO DE ENTREGA DE CHAVES';
  const lines = [
    `${title} (${KEY_DELIVERY_TERM_VERSION})`,
    `Contrato: ${contract.contractNumber || contract.id} (${contract.contractType})`,
    `Imóvel: ${contract.propertyId || '-'}`,
    `Recebedor: ${recipientName}`,
    `Quantidade de chaves/controles: ${keysCount}`,
    `Identificação: ${keysIdentification || 'não informada'}`,
    checkIn
      ? `Vistoria de entrada: ${checkIn.id} (concluída e assinada por locador e locatário)`
      : 'Vistoria de entrada: pendente (exigida concluída e assinada para liberar)',
    `Política de fotos aplicada: ${policy.code}`,
  ];
  if (keyDelivery.termType === 'USED_PROPERTY_DELIVERY') {
    lines.push('O imóvel é entregue USADO, no estado descrito na vistoria acima, que integra este termo.');
  }
  lines.push(signedAt
    ? `Assinado por: ${signerName} em ${signedAt.toISOString()}`
    : `Assinado por: ${signerName || '(definido na liberação)'} — PRÉVIA, ainda não assinado`);
  return lines.join('\n');
}

async function personName(personId, transaction) {
  const person = await Person.findByPk(personId, { transaction });
  return person ? (person.legalName || person.tradeName || person.id) : personId;
}

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

  // ADV (M5-32): o contrato NUNCA era carregado na criação — quem chamasse o service com o
  // UUID de um contrato de outra empresa e o próprio group/company no payload conseguia criar
  // uma entrega de chaves apontando para um contrato que não pode nem ler. `getContract` roda
  // sob o RLS do tenant do chamador, então um contrato de outro tenant simplesmente não existe
  // aqui (404) — e o group/company gravados passam a vir do CONTRATO, não do payload, para que
  // um payload forjado não consiga plantar a linha no tenant errado.
  const contract = await getContract(contractId, transaction);
  await assertContractParty(contract.id, deliveredToPersonId, transaction, RECIPIENT_NOT_PARTY);

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
    ? { id: keyDelivery.inspectionId, contractId: contract.id, inspectionType: 'CHECK_IN', status: 'COMPLETED' }
    : { contractId: contract.id, inspectionType: 'CHECK_IN', status: 'COMPLETED' };
  checkIn = await Inspection.findOne({ where, order: [['created_at', 'DESC']], transaction });
  const policy = resolveKeyDeliveryPhotoPolicy(contract, keyDelivery);
  const n = Number(q.keysCount);
  const termText = buildKeyDeliveryTerm({
    contract,
    keyDelivery,
    keysCount: Number.isFinite(n) && n > 0 ? n : '(a informar)',
    keysIdentification: q.keysIdentification ? String(q.keysIdentification).slice(0, 500) : null,
    signerName: /^[0-9a-f-]{36}$/i.test(String(q.termSignedByPersonId || '')) ? await personName(q.termSignedByPersonId, transaction) : null,
    recipientName: await personName(keyDelivery.deliveredToPersonId, transaction),
    checkIn,
    policy,
    signedAt: null,
  });
  return { preview: true, termVersion: KEY_DELIVERY_TERM_VERSION, termText, termHash: null, photoPolicy: policy.code, photosRequired: policy.photosRequired };
}

/**
 * releaseKeyDelivery — TRAVA de negócio: só libera se o Contract estiver em SIGNED/ACTIVE E
 * existir uma Inspection CHECK_IN COMPLETED para o mesmo contrato (ou, na ausência de
 * contract_id na vistoria, para o mesmo imóvel do contrato — contratos de venda podem ter
 * vistorias sem vínculo direto, mas o caso de uso central aqui é locação).
 */
async function releaseKeyDelivery(id, payload, actorUserId, transaction) {
  const keyDelivery = await getKeyDelivery(id, transaction);
  if (keyDelivery.status === 'RELEASED') {
    throw AppError.conflict('Entrega de chaves já foi liberada.', 'LEGAL_KEY_DELIVERY_ALREADY_RELEASED');
  }

  const contract = await getContract(keyDelivery.contractId, transaction);
  if (!['SIGNED', 'ACTIVE'].includes(contract.status)) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: contrato precisa estar assinado/ativo e a vistoria de entrada concluída.',
      'LEGAL_KEY_DELIVERY_BLOCKED'
    );
  }

  // Caderno Anexo I "10. Entrega de chaves": "Exigir documentos e garantias válidos." Até aqui
  // só o gate de ATIVAÇÃO do contrato (assertActivationGate) reconferia garantias — a entrega de
  // chaves em si não checava nada. Mesmo espírito do gate de ativação: se o contrato tem alguma
  // Guarantee cadastrada, ao menos uma precisa estar ACTIVE (contrato sem nenhuma garantia
  // cadastrada não é bloqueado — "todo contrato exige garantia" não está no Caderno).
  // ACHADO REAL (auditoria independente Nayara, A04): o job que marca garantia vencida como
  // EXPIRED roda periodicamente — entre a data de vencimento real (`endsAt`) e a próxima
  // execução do job, uma garantia pode estar com `endsAt` no passado mas `status` ainda ACTIVE
  // no banco. Checar só `status === 'ACTIVE'` deixava passar essa janela. Agora comparamos
  // `endsAt` contra a data atual DIRETAMENTE aqui também — fail closed, nunca confia só no
  // campo que um job assíncrono ainda não teve chance de atualizar.
  const now = new Date();
  const guarantees = await Guarantee.findAll({ where: { contractId: contract.id }, transaction });
  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-18 — variante do A04): o A04 fechou
  // a ponta do VENCIMENTO (endsAt no passado), mas não a do INÍCIO — uma garantia ACTIVE cuja
  // vigência só COMEÇA no futuro (startsAt > hoje) passava pelo gate e liberava a chave sem
  // nenhuma garantia vigente no ato da entrega. Válida = status ACTIVE E hoje dentro da
  // janela [startsAt, endsAt] (limites ausentes não restringem aquele lado).
  const validGuarantee = guarantees.find(
    (g) =>
      g.status === 'ACTIVE' &&
      (!g.startsAt || new Date(g.startsAt) <= now) &&
      (!g.endsAt || new Date(g.endsAt) >= now)
  );
  if (guarantees.length > 0 && !validGuarantee) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: existem garantias cadastradas para o contrato, mas nenhuma está ativa e dentro da vigência.',
      'LEGAL_KEY_DELIVERY_GUARANTEE_INVALID'
    );
  }

  // FIX (homologação, LOC-2026-0002): quando um contrato tem MAIS DE UMA vistoria de CHECK_IN
  // concluída (ex.: uma antiga já assinada, e uma nova ainda sem assinatura porque a antiga foi
  // refeita), `findOne` sem ORDER escolhia qualquer uma delas — na prática, muitas vezes a mais
  // antiga/assinada, autorizando a entrega mesmo a vistoria REALMENTE vinculada a esta entrega
  // de chaves (keyDelivery.inspectionId) estando pendente de assinatura. A vistoria que importa
  // para o gate é: (1) a explicitamente referenciada por esta entrega de chaves, se houver; ou
  // (2) na ausência de vínculo explícito, a vistoria de CHECK_IN concluída MAIS RECENTE do
  // contrato (nunca "qualquer uma que exista assinada") — ordenada por completed_at/created_at.
  let checkIn = null;
  if (keyDelivery.inspectionId) {
    checkIn = await Inspection.findOne({
      where: { id: keyDelivery.inspectionId, contractId: contract.id, inspectionType: 'CHECK_IN', status: 'COMPLETED' },
      transaction,
    });
    if (!checkIn) {
      throw AppError.conflict(
        'Não é possível liberar as chaves: a vistoria de entrada vinculada a esta entrega não está concluída.',
        'LEGAL_KEY_DELIVERY_BLOCKED'
      );
    }
  } else {
    checkIn = await Inspection.findOne({
      where: { contractId: contract.id, inspectionType: 'CHECK_IN', status: 'COMPLETED' },
      order: [
        ['completedAt', 'DESC'],
        ['created_at', 'DESC'],
      ],
      transaction,
    });
    if (!checkIn && contract.propertyId) {
      // Fallback: algumas vistorias de CHECK_IN podem não estar diretamente vinculadas ao
      // contrato (contract_id nullable em Inspection) — aceitamos também a vistoria concluída
      // MAIS RECENTE do mesmo imóvel. Decisão de engenharia: sem isso, contratos criados após a
      // vistoria (ou vistorias registradas antes do contrato existir) nunca liberariam a chave.
      checkIn = await Inspection.findOne({
        where: { propertyId: contract.propertyId, inspectionType: 'CHECK_IN', status: 'COMPLETED' },
        order: [
          ['completedAt', 'DESC'],
          ['created_at', 'DESC'],
        ],
        transaction,
      });
    }
  }
  if (!checkIn) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: contrato precisa estar assinado/ativo e a vistoria de entrada concluída.',
      'LEGAL_KEY_DELIVERY_BLOCKED'
    );
  }

  // FIX (homologação 22/09/2026, reportado pela cliente): "concluída" (status COMPLETED) não
  // significa "assinada" — completeInspection nunca exigiu nenhuma InspectionSignature. Uma
  // vistoria podia ser marcada como concluída e liberar a chave sem locador NEM locatário terem
  // assinado nada, o que não cumpre o que o Caderno descreve para M5-22 ("vistoria de entrada
  // concluída E ASSINADA"). Exige as duas assinaturas de PARTE (LANDLORD e TENANT) — INSPECTOR é
  // opcional (vistoriador nem sempre é uma parte formal do contrato).
  const checkInSignatures = await InspectionSignature.findAll({ where: { inspectionId: checkIn.id }, transaction });
  const signedRoles = new Set(checkInSignatures.map((s) => s.partyRole));
  const missingRoles = ['LANDLORD', 'TENANT'].filter((role) => !signedRoles.has(role));
  if (missingRoles.length > 0) {
    throw AppError.conflict(
      `Não é possível liberar as chaves: a vistoria de entrada está concluída mas falta(m) a assinatura de ${missingRoles.join(' e ')}.`,
      'LEGAL_KEY_DELIVERY_INSPECTION_NOT_SIGNED'
    );
  }

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
  const { keysCount, keysIdentification, photosFileIds, termSignedByPersonId } = body;
  const policy = resolveKeyDeliveryPhotoPolicy(contract, keyDelivery);
  const photosRequired = policy.photosRequired;
  if (keysCount === undefined || keysCount === null || Number(keysCount) <= 0) {
    throw AppError.badRequest(
      '"keysCount" (quantidade de chaves/controles entregues) é obrigatório e deve ser maior que zero.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  if (!termSignedByPersonId) {
    throw AppError.badRequest(
      '"termSignedByPersonId" é obrigatório — a liberação de chaves exige assinatura do termo de entrega.',
      'LEGAL_KEY_DELIVERY_VALIDATION'
    );
  }
  if (photosRequired && (!Array.isArray(photosFileIds) || photosFileIds.length === 0)) {
    throw AppError.conflict(
      'Não é possível liberar as chaves: a política exige fotos obrigatórias e nenhuma foi informada ("photosFileIds").',
      'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED'
    );
  }

  // Recebedor (entregas antigas, criadas antes da regra F6) e signatário precisam ser partes.
  await assertContractParty(contract.id, keyDelivery.deliveredToPersonId, transaction, RECIPIENT_NOT_PARTY);
  await assertContractParty(contract.id, termSignedByPersonId, transaction, SIGNER_NOT_PARTY);
  const signedAt = new Date();
  const termText = buildKeyDeliveryTerm({
    contract,
    keyDelivery,
    keysCount: Number(keysCount),
    keysIdentification,
    signerName: await personName(termSignedByPersonId, transaction),
    recipientName: await personName(keyDelivery.deliveredToPersonId, transaction),
    checkIn,
    policy,
    signedAt,
  });

  const beforeJson = keyDelivery.toJSON();
  keyDelivery.status = 'RELEASED';
  keyDelivery.deliveredAt = new Date();
  keyDelivery.deliveredByUserId = actorUserId || null;
  keyDelivery.updatedBy = actorUserId || null;
  // FIX (ciclo cético Marco 5): a coluna já existe (migration 20260101000290) e agora está
  // declarada no model — `save()` abaixo persiste de verdade, antes ficava só em memória.
  keyDelivery.keysCount = Number(keysCount);
  keyDelivery.keysIdentification = keysIdentification || null;
  keyDelivery.photosRequired = Boolean(photosRequired);
  keyDelivery.photosFileIds = Array.isArray(photosFileIds) ? photosFileIds : null;
  keyDelivery.termSignedByPersonId = termSignedByPersonId;
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

module.exports = {
  createKeyDelivery,
  listKeyDeliveries,
  getKeyDelivery,
  releaseKeyDelivery,
  previewKeyDeliveryTerm,
  resolveKeyDeliveryPhotoPolicy,
  KEY_DELIVERY_TERM_VERSION,
};
