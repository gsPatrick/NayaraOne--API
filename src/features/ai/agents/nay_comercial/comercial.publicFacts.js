'use strict';

// Guia do Marcelo (Marco 3) §12 "NAY description guard": buildPropertyPrompt(propertyReadModel) entrega ao modelo SÓ
// onlyApprovedPublicFacts(propertyReadModel), com a instrução "Use somente os fatos fornecidos. Não invente metragem, acabamento, localização
// ou benefício.", e a saída passa por validateGeneratedDescription(output, approvedFacts) (comercial.descriptionGuard.js).
// "Fatos públicos aprovados" = os campos da visão pública do imóvel (PublicPropertyReadModel, M9-D231): a mesma montagem que o site e os
// portais recebem (PII e nome de proprietário fora, endereço conforme a visibilidade, só oferta ativa com preço). A leitura aqui é só da
// origem (loadPublicSource) e a montagem é pura (buildPublicRow): nada é gravado no read model nem publicado. Ficam de fora os textos livres
// (título e descrição pública, que é o que está sendo redigido), fotos, vídeo e coordenada. DI-M3CB-24.
const { loadPublicSource } = require('../../../properties/publicReadModel/source.load');
const { buildPublicRow } = require('../../../properties/publicReadModel/row.build');
const { APPROX_RADIUS_DEFAULT } = require('../../../properties/publicReadModel/publicReadModel.settings');
const { brl } = require('./comercial.format');
const { notFound } = require('./comercial.scope');

const TYPE = Object.freeze({ APARTMENT: 'apartamento', HOUSE: 'casa', LAND: 'terreno', COMMERCIAL: 'imóvel comercial', FARM: 'chácara', ROOM: 'sala' });
const INSTRUCTION = 'Use somente os fatos fornecidos. Não invente metragem, acabamento, localização ou benefício.';

const m2 = (n) => `${Number(n).toLocaleString('pt-BR')} m²`;

/**
 * Lista fechada de fatos aprovados, na ordem do texto: { key, label, value (texto que vai à descrição), raw (valor para a guarda) }.
 * Campo vazio na visão pública não vira fato (e, portanto, não pode aparecer na descrição).
 */
function onlyApprovedPublicFacts(row) {
  const facts = [];
  const add = (key, label, raw, value = raw) => { if (raw !== null && raw !== undefined && raw !== '' && !(Array.isArray(raw) && !raw.length)) facts.push({ key, label, value: String(value), raw }); };
  add('type', 'tipo', row.type ? (TYPE[String(row.type).toUpperCase()] || String(row.type).toLowerCase()) : null);
  add('purpose', 'finalidade', row.purpose ? String(row.purpose).toLowerCase() : null);
  add('neighborhood', 'bairro', row.neighborhood);
  add('city', 'cidade', row.city);
  add('state', 'estado', row.state);
  add('area_total', 'área total', row.area_total, row.area_total === null || row.area_total === undefined ? null : m2(row.area_total));
  add('area_built', 'área construída', row.area_built, row.area_built === null || row.area_built === undefined ? null : m2(row.area_built));
  add('bedrooms', 'quartos', row.bedrooms);
  add('bathrooms', 'banheiros', row.bathrooms);
  add('parking_spots', 'vagas', row.parking_spots);
  add('price_public', row.purpose === 'LOCAÇÃO' ? 'aluguel' : 'preço', row.price_public, brl(row.price_public));
  add('condo_fee_public', 'condomínio', row.condo_fee_public, brl(row.condo_fee_public));
  add('iptu_public', 'IPTU', row.iptu_public, brl(row.iptu_public));
  add('features_public', 'características', row.features_public, (row.features_public || []).join(', '));
  return facts;
}

/**
 * Fatos públicos aprovados do imóvel (sob a RLS da transação). Imóvel inexistente ou de outra empresa: 404 sem revelar existência.
 * `publicCode` identifica o imóvel na fonte sem expor o id interno ao modelo.
 */
async function loadApprovedFacts(propertyId, transaction) {
  const source = await loadPublicSource(propertyId, transaction);
  if (!source) throw notFound();
  const row = buildPublicRow(source, { radiusM: APPROX_RADIUS_DEFAULT });
  return { propertyId: source.property.id, publicCode: row.public_code, publicationStatus: source.property.publicationStatus || null, facts: onlyApprovedPublicFacts(row) };
}

/** O pedido ao modelo (Guia §12): os fatos aprovados e a instrução fixa, nada mais do imóvel. */
function buildPropertyPrompt(approved) {
  return { facts: approved.facts, instruction: INSTRUCTION };
}

/** Texto da fonte (o que o modelo lê e o que o aterramento confere): "rótulo: valor" por fato. */
const factsText = (approved) => `Fatos públicos aprovados do imóvel ${approved.publicCode}. ${approved.facts.map((f) => `${f.label}: ${f.value}`).join('. ')}${approved.facts.length ? '.' : 'Nenhum atributo público preenchido.'}`;

module.exports = { onlyApprovedPublicFacts, loadApprovedFacts, buildPropertyPrompt, factsText, INSTRUCTION };
