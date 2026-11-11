'use strict';

const { ContractParty, Person, Property, PropertyAddress } = require('../../../models');

/**
 * Texto do termo de entrega de chaves (livro §10 "Assinatura do termo de entrega"): versões do modelo e montagem do texto.
 * Separado de key-delivery.service.js (que guarda as travas e o fluxo); o texto já gravado de uma entrega nunca é regerado.
 */
// v1 (KD-TERM-v1) continua válido para os termos JÁ gravados — texto e hash preservados, nada é
// regerado. Toda nova liberação/prévia usa o modelo v2 (texto 100% humano, M45 19/10/2026).
const KEY_DELIVERY_TERM_VERSION_V1 = 'KD-TERM-v1';
// v3 (M45-RECONF F7, 19/10/2026): mesmo texto do v2 sem a linha "Modelo KD-TERM-v2" (código
// técnico no documento entregue à pessoa). v1/v2 já gravados continuam intactos (texto e hash).
const KEY_DELIVERY_TERM_VERSION = 'KD-TERM-v3';
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
    policy.text || PHOTO_POLICY_TEXT[policy.code] || 'Fotos: conforme a política da empresa para este tipo de entrega.',
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

module.exports = {
  KEY_DELIVERY_TERM_VERSION,
  KEY_DELIVERY_TERM_VERSION_V1,
  buildKeyDeliveryTermV1,
  buildKeyDeliveryTermV2,
  gatherTermV2Context,
  formatTaxId,
};
