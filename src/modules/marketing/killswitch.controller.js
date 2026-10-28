'use strict';

const { mktNotImplemented } = require('./marketing.errors');

// Corpo da rota: M9-D425 (escopos, motivo, auditoria). A porta de permissão e o MFA da reativação são desta demanda.
async function change() {
  throw mktNotImplemented('M9-D425');
}

module.exports = { change };
