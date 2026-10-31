'use strict';

const { Contract, ContractParty, Guarantee, Person, Property } = require('../../models');
const AppError = require('../../utils/AppError');
const { CONDITION_VARIABLES } = require('./clauseConditions');

/**
 * clauseConditionContext — F01: o contexto que decide se uma cláusula condicional entra no
 * documento é DERIVADO no servidor a partir dos dados do contrato. Nunca vem do cliente: se
 * viesse, quem gera o contrato poderia "declarar" uma garantia que não existe e incluir ou
 * excluir cláusula à vontade.
 *
 * Origem de cada variável:
 *  - contractType     → contrato.contract_type
 *  - totalValue       → contrato.total_value (DECIMAL convertido para número)
 *  - termMonths       → meses entre starts_at e ends_at (arredondado ao mês mais próximo)
 *  - guaranteeType    → modalidade das garantias com status ACTIVE do contrato; nenhuma = NONE
 *  - hasGuarantor     → existe garantia ACTIVE do tipo GUARANTOR (fiança)
 *  - tenantPersonType → PF/PJ das partes TENANT (locação) ou BUYER (venda)
 *  - propertyPurpose  → subtipo do contrato (LEASE_RESIDENTIAL/COMMERCIAL/SEASONAL); sem
 *                       subtipo, o tipo do imóvel quando for RESIDENTIAL/COMMERCIAL
 *
 * Valor que não pode ser determinado fica AUSENTE do contexto (regra que o consulta vira erro
 * explícito, nunca "falso" silencioso). Valor ambíguo vai para `unresolved` com o motivo:
 *  - mais de uma modalidade de garantia ativa: a Lei do Inquilinato (8.245/91, art. 37,
 *    parágrafo único) veda mais de uma modalidade no mesmo contrato de locação, e a variável é
 *    de valor único — a cláusula que depende dela não pode ser decidida até regularizar;
 *  - locatários/compradores PF e PJ ao mesmo tempo.
 */

const PURPOSE_BY_CONTRACT_TYPE = {
  LEASE_RESIDENTIAL: 'RESIDENTIAL',
  LEASE_COMMERCIAL: 'COMMERCIAL',
  LEASE_SEASONAL: 'SEASONAL',
};
const PURPOSE_BY_PROPERTY_TYPE = { RESIDENTIAL: 'RESIDENTIAL', COMMERCIAL: 'COMMERCIAL' };
const COUNTERPARTY_ROLES = ['TENANT', 'BUYER'];
const DAYS_PER_MONTH = 30.4375;

function monthsBetween(startsAt, endsAt) {
  if (!startsAt || !endsAt) return null;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  const days = (end.getTime() - start.getTime()) / 86400000;
  return Math.max(1, Math.round(days / DAYS_PER_MONTH));
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * deriveConditionContext — monta o contexto a partir de dados de contrato (existente ou
 * rascunho). `propertyId` e `parties[].personId` são lidos do banco (sob RLS), nunca confiados
 * como "tipo de pessoa"/"tipo de imóvel" informados pelo chamador.
 */
async function deriveConditionContext({ contractType, totalValue, startsAt, endsAt, propertyId, parties = [], guarantees = [] }, transaction) {
  const context = {};
  const unresolved = {};

  if (contractType && CONDITION_VARIABLES.contractType.values.includes(contractType)) {
    context.contractType = contractType;
  }

  const value = toNumberOrNull(totalValue);
  if (value !== null) context.totalValue = value;

  const months = monthsBetween(startsAt, endsAt);
  if (months !== null) context.termMonths = months;

  const activeTypes = [...new Set(guarantees.filter((g) => g.status === 'ACTIVE').map((g) => g.guaranteeType))];
  if (activeTypes.length === 0) {
    context.guaranteeType = 'NONE';
  } else if (activeTypes.length === 1 && CONDITION_VARIABLES.guaranteeType.values.includes(activeTypes[0])) {
    context.guaranteeType = activeTypes[0];
  } else {
    unresolved.guaranteeType = `O contrato tem mais de uma modalidade de garantia ativa (${activeTypes.join(', ')}); a Lei 8.245/91, art. 37, parágrafo único, veda mais de uma no mesmo contrato de locação. Regularize as garantias antes de gerar o documento.`;
  }
  context.hasGuarantor = guarantees.some((g) => g.status === 'ACTIVE' && g.guaranteeType === 'GUARANTOR');

  const counterpartyIds = [...new Set(parties.filter((p) => COUNTERPARTY_ROLES.includes(p.partyRole)).map((p) => p.personId))];
  if (counterpartyIds.length) {
    const people = await Person.findAll({ where: { id: counterpartyIds }, attributes: ['id', 'personType'], transaction });
    if (people.length !== counterpartyIds.length) {
      throw AppError.badRequest('Parte do contrato não encontrada nesta empresa.', 'LEGAL_CLAUSE_CONDITION_CONTEXT_INVALID');
    }
    const personTypes = [...new Set(people.map((p) => p.personType))];
    if (personTypes.length === 1 && CONDITION_VARIABLES.tenantPersonType.values.includes(personTypes[0])) {
      context.tenantPersonType = personTypes[0];
    } else {
      unresolved.tenantPersonType = 'Há locatários/compradores pessoa física e pessoa jurídica no mesmo contrato — a regra que depende do tipo de pessoa não pode ser decidida automaticamente.';
    }
  }

  if (PURPOSE_BY_CONTRACT_TYPE[contractType]) {
    context.propertyPurpose = PURPOSE_BY_CONTRACT_TYPE[contractType];
  } else if (propertyId) {
    const property = await Property.findByPk(propertyId, { attributes: ['id', 'propertyType'], transaction });
    if (!property) {
      throw AppError.badRequest('Imóvel do contrato não encontrado nesta empresa.', 'LEGAL_CLAUSE_CONDITION_CONTEXT_INVALID');
    }
    const purpose = PURPOSE_BY_PROPERTY_TYPE[String(property.propertyType || '').toUpperCase()];
    if (purpose) context.propertyPurpose = purpose;
  }

  return { context, unresolved };
}

/** buildConditionContext — contexto de um contrato já gravado (partes e garantias do banco). */
async function buildConditionContext(contractOrId, transaction) {
  const contract = typeof contractOrId === 'string'
    ? await Contract.findByPk(contractOrId, { transaction })
    : contractOrId;
  if (!contract) throw AppError.notFound('Contrato não encontrado.', 'LEGAL_CONTRACT_NOT_FOUND');
  const [parties, guarantees] = await Promise.all([
    ContractParty.findAll({ where: { contractId: contract.id }, attributes: ['personId', 'partyRole'], transaction }),
    Guarantee.findAll({ where: { contractId: contract.id }, attributes: ['guaranteeType', 'status'], transaction }),
  ]);
  return deriveConditionContext(
    {
      contractType: contract.contractType,
      totalValue: contract.totalValue,
      startsAt: contract.startsAt,
      endsAt: contract.endsAt,
      propertyId: contract.propertyId,
      parties: parties.map((p) => ({ personId: p.personId, partyRole: p.partyRole })),
      guarantees: guarantees.map((g) => ({ guaranteeType: g.guaranteeType, status: g.status })),
    },
    transaction
  );
}

/**
 * deriveDraftConditionContext — pré-visualização da tela "Novo contrato", antes de o contrato
 * existir. Os dados vêm do formulário, mas imóvel e pessoas são lidos do banco; um contrato novo
 * ainda não tem garantia cadastrada, então guaranteeType = NONE (o mesmo resultado que a geração
 * real dará logo depois de criar o contrato).
 */
async function deriveDraftConditionContext(draft, transaction) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw AppError.badRequest('"draftContract" deve ser um objeto com os dados do contrato em criação.', 'LEGAL_CLAUSE_CONDITION_CONTEXT_INVALID');
  }
  const parties = Array.isArray(draft.parties)
    ? draft.parties.map((p) => ({ personId: p && p.personId, partyRole: p && p.partyRole })).filter((p) => p.personId && p.partyRole)
    : [];
  return deriveConditionContext(
    {
      contractType: draft.contractType,
      totalValue: draft.totalValue,
      startsAt: draft.startsAt,
      endsAt: draft.endsAt,
      propertyId: draft.propertyId,
      parties,
      guarantees: [],
    },
    transaction
  );
}

module.exports = { buildConditionContext, deriveDraftConditionContext, deriveConditionContext, monthsBetween };
