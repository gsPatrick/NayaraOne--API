'use strict';

const { govError, govNotFound } = require('../core-governance/governance.errors');

/** Erros das referências de IDs legados (M9-D906 §4). Códigos novos levam GOV_. */
module.exports = {
  duplicate: () => govError(409, 'GOV_EXTREF_DUPLICATE', 'Este código antigo já está ligado a outro registro.'),
  primaryDuplicate: () => govError(409, 'GOV_EXTREF_PRIMARY_DUPLICATE', 'Este registro já tem um código antigo principal neste sistema.'),
  immutable: () => govError(409, 'GOV_EXTREF_IMMUTABLE', 'Referências antigas não podem ser apagadas; encerre a vigência.'),
  keyRequired: () => govError(422, 'GOV_EXTREF_KEY_REQUIRED', 'Informe o código antigo.'),
  keyInvalid: (max) => govError(422, 'GOV_EXTREF_KEY_INVALID', `O código antigo deve ter até ${max} caracteres.`),
  systemInvalid: () => govError(422, 'GOV_EXTREF_SYSTEM_INVALID', 'Informe o sistema de origem (letras maiúsculas, números e sublinhado).'),
  entityTypeInvalid: (allowed) => govError(422, 'GOV_EXTREF_ENTITY_TYPE_INVALID', 'Tipo de registro inválido para o código antigo.', { allowed }),
  ambiguous: () => govError(409, 'GOV_EXTREF_AMBIGUOUS', 'Este código antigo vale para mais de um tipo de registro; informe o tipo.'),
  entityInvalid: () => govError(422, 'GOV_EXTREF_ENTITY_INVALID', 'Informe o registro novo ao qual o código antigo pertence.'),
  instantInvalid: () => govError(422, 'GOV_EXTREF_DATE_INVALID', 'Data inválida para o código antigo.'),
  notFound: () => govNotFound('Código antigo não encontrado.'),
};
