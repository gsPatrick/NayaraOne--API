'use strict';

const { ContractParty, Person, Property, Project } = require('../../../../models');

/**
 * Fatos que as condições (`when`) dos itens da regra REG-JUR-001 podem consultar (Caderno M5 §7: "tipo de contrato + regras +
 * características das partes/imóvel"). Tudo vem do CADASTRO (contrato, partes, pessoas, imóvel e obra), nunca do corpo da
 * requisição. Lista fechada: a publicação de nova versão da regra recusa condição sobre fato fora dela (fato digitado errado
 * avaliaria sempre "falso" sem ninguém perceber).
 *
 * property.isNew: o imóvel é "casa nova" quando nasceu de uma obra da empresa (construction.projects com este imóvel) —
 * o fluxo "Entrega de casa nova" do §7; sem obra, é imóvel usado e vale o "Termo específico" do §7 (DI-M5CT-3).
 */
const KNOWN_FACTS = Object.freeze({
  contractType: 'Tipo do contrato (código do Caderno §3).',
  'parties.count': 'Quantidade de partes cadastradas.',
  'parties.anyPF': 'Alguma parte é pessoa física.',
  'parties.anyPJ': 'Alguma parte é pessoa jurídica.',
  'parties.anyRepresented': 'Alguma parte é representada por procurador.',
  'parties.roles': 'Papéis das partes (LANDLORD, TENANT, GUARANTOR, BUYER, SELLER).',
  'property.linked': 'O contrato tem imóvel vinculado.',
  'property.propertyType': 'Tipo do imóvel (RESIDENTIAL, COMMERCIAL, LAND, RURAL).',
  'property.hasRegistry': 'O imóvel tem matrícula cadastrada.',
  'property.isNew': 'O imóvel é casa nova (nasceu de obra da empresa).',
});

/** Caminhos de fato usados numa condição (and/or/not/fact). */
function factsOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node.and)) node.and.forEach((n) => factsOf(n, out));
  if (Array.isArray(node.or)) node.or.forEach((n) => factsOf(n, out));
  if (node.not !== undefined) factsOf(node.not, out);
  if (typeof node.fact === 'string') out.push(node.fact);
  return out;
}

/** Fatos do contrato, das partes (do cadastro) e do imóvel que as condições dos itens consultam. */
async function buildFacts(contract, transaction) {
  const parties = await ContractParty.findAll({ where: { contractId: contract.id }, transaction });
  const persons = parties.length ? await Person.findAll({ where: { id: parties.map((p) => p.personId) }, attributes: ['id', 'personType'], transaction }) : [];
  const types = new Set(persons.map((p) => p.personType));
  const property = contract.propertyId ? await Property.findByPk(contract.propertyId, { attributes: ['id', 'propertyType', 'registryNumber'], transaction }) : null;
  const obras = property ? await Project.count({ where: { propertyId: property.id }, transaction }) : 0;
  return {
    contractType: contract.contractType,
    parties: { count: parties.length, anyPF: types.has('PF'), anyPJ: types.has('PJ'), anyRepresented: parties.some((p) => !!p.representedByPersonId), roles: [...new Set(parties.map((p) => p.partyRole))] },
    property: { linked: !!property, propertyType: property ? property.propertyType : null, hasRegistry: !!(property && property.registryNumber), isNew: obras > 0 },
  };
}

module.exports = { KNOWN_FACTS, factsOf, buildFacts };
