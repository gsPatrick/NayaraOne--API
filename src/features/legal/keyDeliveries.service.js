'use strict';

const crypto = require('crypto');
const { KeyDelivery, Inspection, InspectionSignature, Guarantee, ContractParty, Person, Property, PropertyAddress } = require('../../models');
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
// v1 (KD-TERM-v1) continua válido para os termos JÁ gravados — texto e hash preservados, nada é
// regerado. Toda nova liberação/prévia usa o modelo v2 (texto 100% humano, M45 19/10/2026).
const KEY_DELIVERY_TERM_VERSION_V1 = 'KD-TERM-v1';
// v3 (M45-RECONF F7, 19/10/2026): mesmo texto do v2 sem a linha "Modelo KD-TERM-v2" (código
// técnico no documento entregue à pessoa). v1/v2 já gravados continuam intactos (texto e hash).
const KEY_DELIVERY_TERM_VERSION = 'KD-TERM-v3';
const CLIENT_FORBIDDEN_FIELDS = ['photosRequired', 'photoPolicy', 'termText', 'termVersion', 'termHash', 'policy'];

function resolveKeyDeliveryPhotoPolicy(contract, keyDelivery) {
  if (keyDelivery.termType === 'USED_PROPERTY_DELIVERY') return { code: 'REQUIRED_USED_PROPERTY', photosRequired: true };
  if (isSaleLikeContractType(contract.contractType)) return { code: 'REQUIRED_SALE_DELIVERY', photosRequired: true };
  return { code: 'NOT_REQUIRED_LEASE_CHECKIN_SIGNED', photosRequired: false };
}

function buildKeyDeliveryTermV1({ contract, keyDelivery, keysCount, keysIdentification, signerName, recipientName, checkIn, policy, signedAt }) {
  const title = keyDelivery.termType === 'USED_PROPERTY_DELIVERY'
    ? 'TERMO DE ENTREGA DE IMÓVEL USADO E CHAVES'
    : 'TERMO DE ENTREGA DE CHAVES';
  const lines = [
    `${title} (${KEY_DELIVERY_TERM_VERSION_V1})`,
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

// ---------------------------------------------------------------------------------------------
// KD-TERM-v2 — texto para gente: tipo de contrato por rótulo, imóvel por endereço/nome, política
// de fotos em frase, partes por nome + CPF/CNPJ formatado, datas no padrão brasileiro.
// ---------------------------------------------------------------------------------------------
const CONTRACT_TYPE_LABELS = {
  SALE: 'Venda', SALE_CASH: 'Venda à vista', SALE_FINANCED: 'Venda financiada', SALE_TRADE: 'Venda com permuta',
  SALE_INSTALLMENTS: 'Venda parcelada', LEASE: 'Locação', LEASE_RESIDENTIAL: 'Locação residencial',
  LEASE_COMMERCIAL: 'Locação comercial', LEASE_SEASONAL: 'Locação por temporada', PROPERTY_ADMIN: 'Administração de imóvel',
  SERVICE: 'Prestação de serviço', CONSTRUCTION: 'Obra / Construção (empreitada)',
};
const PHOTO_POLICY_TEXT = {
  REQUIRED_USED_PROPERTY: 'Fotos obrigatórias: por se tratar de entrega de imóvel usado, o estado do imóvel é registrado em fotos anexadas a este termo.',
  REQUIRED_SALE_DELIVERY: 'Fotos obrigatórias: por se tratar de entrega de imóvel vendido, o estado do imóvel é registrado em fotos anexadas a este termo.',
  NOT_REQUIRED_LEASE_CHECKIN_SIGNED: 'Fotos não obrigatórias nesta entrega: o estado do imóvel já está registrado na vistoria de entrada assinada pelo locador e pelo locatário.',
};
const PARTY_ROLE_LABELS = {
  LANDLORD: 'Locador(a)', TENANT: 'Locatário(a)', BUYER: 'Comprador(a)', SELLER: 'Vendedor(a)', GUARANTOR: 'Fiador(a)',
  OWNER: 'Proprietário(a)', WITNESS: 'Testemunha', CONTRACTOR: 'Contratante', CONTRACTED: 'Contratado(a)', BROKER: 'Corretor(a)',
};

function formatTaxId(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length === 11) return `CPF ${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `CNPJ ${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return null;
}

const BR_TZ = 'America/Sao_Paulo';
function formatDateBR(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: BR_TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}
function formatDateTimeBR(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const date = formatDateBR(d);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: BR_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${date} às ${time}`;
}

async function describePerson(personId, contractId, transaction) {
  if (!personId) return null;
  const person = await Person.findByPk(personId, { transaction });
  const party = contractId ? await ContractParty.findOne({ where: { contractId, personId }, transaction }) : null;
  const name = person ? (person.legalName || person.preferredName || 'pessoa sem nome cadastrado') : 'pessoa não encontrada';
  const doc = person ? formatTaxId(person.taxIdNormalized) : null;
  const role = party ? PARTY_ROLE_LABELS[party.partyRole] : null;
  return [name, doc ? `(${doc})` : '(documento não cadastrado)', role ? `— ${role} no contrato` : null].filter(Boolean).join(' ');
}

async function describeProperty(propertyId, transaction) {
  if (!propertyId) return 'não vinculado ao contrato';
  const property = await Property.findByPk(propertyId, { transaction });
  if (!property) return 'imóvel não encontrado';
  let addressText = null;
  if (property.addressId) {
    const a = await PropertyAddress.findByPk(property.addressId, { transaction });
    if (a) {
      const first = [a.street, a.number].filter(Boolean).join(', ');
      const parts = [first, a.complement, a.neighborhood, [a.city, a.state].filter(Boolean).join('/')].filter(Boolean);
      if (a.zipCode) {
        const z = String(a.zipCode).replace(/\D/g, '');
        parts.push(z.length === 8 ? `CEP ${z.slice(0, 5)}-${z.slice(5)}` : `CEP ${a.zipCode}`);
      }
      addressText = parts.join(' — ') || null;
    }
  }
  if (!addressText && property.addressLine) {
    addressText = [property.addressLine, [property.city, property.state].filter(Boolean).join('/')].filter(Boolean).join(' — ');
  }
  const name = property.title || property.internalCode || null;
  if (name && addressText) return `${name}, ${addressText}`;
  return name || addressText || 'imóvel sem nome nem endereço cadastrado';
}

/** Junta tudo que o texto v2 precisa (leituras) — o builder em si é puro. */
async function gatherTermV2Context({ contract, keyDelivery, termSignedByPersonId, checkIn }, transaction) {
  return {
    propertyText: await describeProperty(contract.propertyId, transaction),
    recipientText: await describePerson(keyDelivery.deliveredToPersonId, contract.id, transaction),
    signerText: termSignedByPersonId ? await describePerson(termSignedByPersonId, contract.id, transaction) : null,
    checkInDate: checkIn ? formatDateBR(checkIn.completedAt || checkIn.updatedAt || checkIn.updated_at) : null,
  };
}

function buildKeyDeliveryTermV2({ contract, keyDelivery, keysCount, keysIdentification, checkIn, policy, signedAt, ctx }) {
  const usedProperty = keyDelivery.termType === 'USED_PROPERTY_DELIVERY';
  const title = usedProperty ? 'TERMO DE ENTREGA DE IMÓVEL USADO E CHAVES' : 'TERMO DE ENTREGA DE CHAVES';
  const typeLabel = CONTRACT_TYPE_LABELS[contract.contractType] || 'Contrato';
  const contractDate = formatDateBR(contract.startsAt);
  const qty = typeof keysCount === 'number'
    ? `${keysCount} ${keysCount === 1 ? 'chave/controle' : 'chaves/controles'}`
    : 'a informar';
  const lines = [
    title,
    '',
    `Contrato: ${contract.contractNumber || 'sem número'} — ${typeLabel}${contractDate ? ` (início em ${contractDate})` : ''}`,
    `Imóvel: ${ctx.propertyText}`,
    `Recebedor das chaves: ${ctx.recipientText}`,
    `Quantidade entregue: ${qty}`,
    `Identificação das chaves/controles: ${keysIdentification || 'não informada'}`,
    checkIn
      ? `Vistoria de entrada: concluída${ctx.checkInDate ? ` em ${ctx.checkInDate}` : ''} e assinada pelo locador e pelo locatário.`
      : 'Vistoria de entrada: ainda pendente — a liberação exige a vistoria concluída e assinada.',
    PHOTO_POLICY_TEXT[policy.code] || 'Fotos: conforme a política da empresa para este tipo de entrega.',
  ];
  if (usedProperty) {
    lines.push('O imóvel é entregue usado, no estado descrito na vistoria acima, que faz parte deste termo.');
  }
  lines.push('');
  lines.push(signedAt
    ? `Assinado por ${ctx.signerText} em ${formatDateTimeBR(signedAt)} (horário de Brasília).`
    : `Assinatura: ${ctx.signerText || 'a definir na liberação'} — PRÉVIA, ainda não assinado.`);
  return lines.join('\n');
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
  const ctx = await gatherTermV2Context({ contract, keyDelivery, termSignedByPersonId, checkIn }, transaction);
  const termText = buildKeyDeliveryTermV2({
    contract,
    keyDelivery,
    keysCount: Number(keysCount),
    keysIdentification,
    checkIn,
    policy,
    signedAt,
    ctx,
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
