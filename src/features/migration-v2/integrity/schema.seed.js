'use strict';

const text = (field) => ({ field, type: 'text' });

const PERSON_FIELDS = Object.freeze([text('personType'), text('legalName'), text('preferredName'), text('taxId'), { field: 'birthDate', type: 'date' }]);
const PROPERTY_FIELDS = Object.freeze([
  text('internalCode'), text('title'), text('propertyType'), text('addressLine'), text('city'), text('state'), text('zipCode'),
  { field: 'areaTotalM2', type: 'decimal', scale: 6 }, { field: 'bedrooms', type: 'int' }, { field: 'parkingSpots', type: 'int' }, text('description'),
]);

/**
 * Ordem canônica dos campos de cada entidade (M9-D905 §3.1). É a ordem do hash: mudar a ordem muda todas as raízes, então a semente só acrescenta entidades. O fornecedor é
 * pessoa com papel, por isso usa os campos de PERSON. A escala de `areaTotalM2` é a da coluna do destino (numeric(9,6)).
 */
const ENTITY_SCHEMA_SEEDS = Object.freeze({ PERSON: PERSON_FIELDS, SUPPLIER: PERSON_FIELDS, PROPERTY: PROPERTY_FIELDS });

module.exports = { ENTITY_SCHEMA_SEEDS };
