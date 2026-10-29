'use strict';

const { loadRelationshipFacts } = require('../publicReadModel');
const { readPropertyStatus } = require('./queries');
const { mktError } = require('../../marketing.errors');

/**
 * M9-D409 — fatos de cada tipo. O snapshot de fatos da versão é igual ao que a fonte devolve AGORA para aquele tipo (o hash da M9-D405
 * compara os dois), então a projeção por tipo vale tanto na geração quanto na conferência de mudança da fonte.
 */
const MONEY_AND_ADDRESS_FIELDS = Object.freeze(['precoVenda', 'precoLocacao', 'precoAnterior', 'condominio', 'iptu', 'logradouro', 'numeroEndereco']);
const SOLD_STATUS = Object.freeze({ SOLD: 'VENDIDO', RENTED: 'ALUGADO' });
const MARCO_OF_TYPE = Object.freeze({ BIRTHDAY_RELATIONSHIP: 'BIRTHDAY', POST_SALE: 'POST_SALE_KEYS' });

/** SOLD_RENTED nunca carrega valor, endereço detalhado, comprador ou locatário: só tipo, bairro, situação e fotos. */
async function projectPropertyFacts(contentType, payload, propertyId, tenant, transaction) {
  if (contentType !== 'SOLD_RENTED') return payload;
  const facts = {};
  for (const [key, value] of Object.entries(payload)) if (!MONEY_AND_ADDRESS_FIELDS.includes(key)) facts[key] = value;
  const status = await readPropertyStatus(propertyId, tenant, transaction);
  facts.status = status && SOLD_STATUS[status.availability] ? SOLD_STATUS[status.availability] : null;
  return facts;
}

/** Fatos de relacionamento (primeiro nome, marco, dia e mês): dado pessoal, só para canal privado. */
async function loadPersonFacts(contentType, personId, tenant, transaction) {
  const marco = MARCO_OF_TYPE[contentType];
  if (!marco) return null;
  const rows = await loadRelationshipFacts({ personId, marco }, tenant, transaction);
  if (rows.length === 0) throw mktError(404, 'MKT_SOURCE_NOT_FOUND', 'A pessoa não tem dados de relacionamento para este conteúdo.');
  const row = rows[rows.length - 1];
  const facts = { primeiroNome: row.primeiroNome, marco: row.marco, dia: row.dia, mes: row.mes };
  if (row.dataMarco) facts.dataMarco = row.dataMarco instanceof Date ? row.dataMarco.toISOString().slice(0, 10) : String(row.dataMarco).slice(0, 10);
  return { version: null, facts };
}

module.exports = { projectPropertyFacts, loadPersonFacts, MARCO_OF_TYPE, MONEY_AND_ADDRESS_FIELDS };
