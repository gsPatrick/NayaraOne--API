'use strict';

const { DIMENSIONS } = require('./quality.constants');

const { COMPLETENESS: C, CONSISTENCY: S } = DIMENSIONS;

/**
 * Catálogo padrão das regras de qualidade (M9-D806 §3.1); os pesos de cada entidade somam 100. `expression` e `appliesWhen` são nomes das verificações
 * de quality.checks.js. O administrador muda peso, severidade e liga/desliga pelos parâmetros governanca.dados.qualidade.* (quality.settings.js).
 */
const rule = (code, entityType, dimension, severity, weight, expression, appliesWhen = null) => Object.freeze({ code, entityType, dimension, severity, weight, expression, appliesWhen });

const RULE_CATALOG = Object.freeze([
  rule('PERSON_TAX_ID_PRESENT', 'PERSON', C, 'HIGH', 20, 'taxIdPresent'),
  rule('PERSON_TAX_ID_VALID', 'PERSON', S, 'CRITICAL', 25, 'taxIdValid'),
  rule('PERSON_CONTACT_PRESENT', 'PERSON', C, 'MEDIUM', 15, 'contactPresent'),
  rule('PERSON_ADDRESS_COMPLETE', 'PERSON', C, 'MEDIUM', 15, 'personAddressComplete'),
  rule('PERSON_BIRTH_COHERENT', 'PERSON', S, 'MEDIUM', 10, 'birthCoherent'),
  rule('PERSON_NAME_NO_DIGITS', 'PERSON', S, 'LOW', 5, 'nameWithoutDigits', 'isIndividual'),
  rule('PERSON_ROLE_DEFINED', 'PERSON', C, 'LOW', 10, 'roleDefined'),
  rule('PROPERTY_REGISTRY_PRESENT', 'PROPERTY', C, 'HIGH', 20, 'registryPresent'),
  rule('PROPERTY_ADDRESS_COMPLETE', 'PROPERTY', C, 'HIGH', 20, 'propertyAddressComplete'),
  rule('PROPERTY_OWNER_LINKED', 'PROPERTY', C, 'CRITICAL', 25, 'ownerLinked'),
  rule('PROPERTY_AREA_POSITIVE', 'PROPERTY', S, 'MEDIUM', 15, 'areaPositive'),
  rule('PROPERTY_PURPOSE_DEFINED', 'PROPERTY', C, 'MEDIUM', 10, 'purposeDefined'),
  rule('PROPERTY_MEDIA_MIN', 'PROPERTY', C, 'LOW', 10, 'mediaMinimum'),
  rule('SUPPLIER_TAX_ID_VALID', 'SUPPLIER', S, 'CRITICAL', 30, 'taxIdValid'),
  rule('SUPPLIER_CONTACT_PRESENT', 'SUPPLIER', C, 'MEDIUM', 20, 'contactPresent'),
  rule('SUPPLIER_BANK_VALIDATED', 'SUPPLIER', C, 'HIGH', 25, 'bankValidated'),
  rule('SUPPLIER_CATEGORY_DEFINED', 'SUPPLIER', C, 'LOW', 10, 'categoryDefined'),
  rule('SUPPLIER_QUALIFICATION_VALID', 'SUPPLIER', C, 'MEDIUM', 15, 'qualificationValid', 'categoryRequiresQualification'),
]);

const CODES = Object.freeze(RULE_CATALOG.map((item) => item.code));

module.exports = { RULE_CATALOG, CODES };
