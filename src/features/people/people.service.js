'use strict';

// Barrel fino: reexporta o CRUD de Person e seus colaboradores especializados
// (dedup / formato de documento) mantendo um único ponto de entrada estável para
// quem já dependia de `people.service.js` (ex.: testes de integração).
// Novo código deve preferir importar diretamente person.service.js / personDedup.service.js /
// personDocumentFormat.service.js conforme a responsabilidade necessária.

const personService = require('./person.service');
const { findPotentialDuplicate } = require('./personDedup.service');
const { validateDocumentFormat, onlyDigits } = require('./personDocumentFormat.service');

module.exports = {
  ...personService,
  findPotentialDuplicate,
  validateDocumentFormat,
  onlyDigits,
};
