'use strict';

const AppError = require('../../utils/AppError');

/**
 * Parâmetros do gate de publicação do imóvel (livro do Marco 3 §7: "Publicação usa Motor de Regras para checar vídeo,
 * quantidade/qualidade de fotos, documentos e campos obrigatórios"). O livro não diz QUAIS documentos nem QUAIS campos:
 * viram parâmetro da empresa (regra do Patrick; DI-M3IM-1 e DI-M3IM-3), editável em Configurações > Imóveis e CRM. O Motor de
 * Regras continua decidindo (REG-IMO-DOCS-001 e REG-IMO-FIELDS-001, fail-closed); estes parâmetros dizem o que ele confere.
 *
 * Padrão = comportamento atual do código: documentos REGISTRY e IPTU (a lista que estava fixa no gate) e os campos que a tela de
 * cadastro já exige (nome, código interno, tipo, endereço completo e ao menos um proprietário).
 */
const REQUIRED_DOCUMENT_TYPES_KEY = 'real_estate.publication.required_document_types';
const REQUIRED_FIELDS_KEY = 'real_estate.publication.required_fields';

const DOCUMENT_TYPES = Object.freeze(['IPTU', 'CONDO_FEE', 'REGISTRY', 'REGULARIZATION_CERTIFICATE']);

// Catálogo fechado dos campos que o gate sabe conferir no imóvel físico (o que é da oferta, como preço, já é exigido na oferta).
const FIELD_CATALOG = Object.freeze({
  title: 'nome / referência do imóvel',
  internalCode: 'código interno',
  propertyType: 'tipo do imóvel',
  address: 'endereço completo (CEP, logradouro, bairro, cidade e UF)',
  owner: 'ao menos um proprietário',
  description: 'descrição',
  descriptionPublic: 'descrição pública (site e portais)',
  areaTotalM2: 'área total (m²)',
  bedrooms: 'quartos',
  parkingSpots: 'vagas',
  registryNumber: 'matrícula',
  coordinates: 'latitude e longitude',
});

const DEFAULT_REQUIRED_DOCUMENT_TYPES = 'REGISTRY,IPTU';
const DEFAULT_REQUIRED_FIELDS = 'title,internalCode,propertyType,address,owner';

function parseList(value) {
  return [...new Set(String(value || '').split(',').map((v) => v.trim()).filter(Boolean))];
}

function listValidator(allowed, label) {
  return (key, value) => {
    const items = parseList(value);
    const unknown = items.filter((item) => !allowed.includes(item));
    if (items.length === 0 || unknown.length > 0) {
      throw AppError.badRequest(
        `O valor de "${key}" deve ser uma lista, separada por vírgula, de ${label}: ${allowed.join(', ')}${unknown.length ? ` (desconhecido: ${unknown.join(', ')})` : ''}.`,
        'SETTING_INVALID_VALUE',
        { key, value, allowed }
      );
    }
  };
}

const PROPERTY_PUBLICATION_SETTINGS_SCHEMA = Object.freeze({
  [REQUIRED_DOCUMENT_TYPES_KEY]: { type: 'string', validate: listValidator(DOCUMENT_TYPES, 'tipos de documento') },
  [REQUIRED_FIELDS_KEY]: { type: 'string', validate: listValidator(Object.keys(FIELD_CATALOG), 'campos') },
});

module.exports = {
  PROPERTY_PUBLICATION_SETTINGS_SCHEMA,
  REQUIRED_DOCUMENT_TYPES_KEY,
  REQUIRED_FIELDS_KEY,
  DEFAULT_REQUIRED_DOCUMENT_TYPES,
  DEFAULT_REQUIRED_FIELDS,
  DOCUMENT_TYPES,
  FIELD_CATALOG,
  parseList,
};
