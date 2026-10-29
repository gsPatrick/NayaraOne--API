'use strict';

/**
 * Campos que a alteração em massa aceita (M9-D808 §3.1), lista fechada por tipo de cadastro. `filter` diz por quais campos o lote pode selecionar
 * (igualdade, lista IN ou nulo); `patch` diz o que pode mudar e onde: `record` = o próprio cadastro, `bank` = as contas bancárias da pessoa
 * (campos críticos da M9-D807), `review` = os itens abertos da fila de revisão do cadastro (troca de curador). Nome de campo fora daqui é recusado:
 * nada vira SQL, só nomes de atributo do modelo.
 */
const text = (max, { nullable = true } = {}) => ({ kind: 'text', max, nullable });
const PERSON_FILTER = { status: text(30), personType: text(10), legalName: text(200), preferredName: text(150) };
const PERSON_PATCH = {
  preferredName: { ...text(150), target: 'record' },
  legalName: { ...text(200, { nullable: false }), target: 'record' },
  birthOrFoundationDate: { kind: 'date', nullable: true, target: 'record' },
  bankCode: { ...text(16), target: 'bank' },
  agency: { ...text(16), target: 'bank' },
  accountNumber: { ...text(32), target: 'bank' },
  pixKey: { ...text(255), target: 'bank' },
  assignedStewardId: { kind: 'user', nullable: true, target: 'review' },
};

const FIELDS = Object.freeze({
  PERSON: { filter: PERSON_FILTER, patch: PERSON_PATCH },
  SUPPLIER: { filter: PERSON_FILTER, patch: PERSON_PATCH },
  PROPERTY: {
    filter: {
      city: text(128), state: text(2), zipCode: text(16), propertyType: text(32), availabilityStatus: text(30), publicationStatus: text(30), registryOffice: text(150), title: text(255),
    },
    patch: {
      city: { ...text(128), target: 'record' },
      state: { ...text(2), target: 'record' },
      zipCode: { ...text(16), target: 'record' },
      addressLine: { ...text(255), target: 'record' },
      registryOffice: { ...text(150), target: 'record' },
      registryNumber: { ...text(100), target: 'record' },
      description: { ...text(5000), target: 'record' },
      availabilityStatus: { kind: 'enum', values: ['AVAILABLE', 'SOLD', 'RENTED', 'WITHDRAWN'], nullable: false, target: 'record' },
      assignedStewardId: { kind: 'user', nullable: true, target: 'review' },
    },
  },
});

module.exports = { FIELDS };
