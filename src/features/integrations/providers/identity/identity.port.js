'use strict';

const { definePort } = require('../ports/definePort');

/** Port IdentityAdapter (domínio IDENTITY, M9-D209): operações, entradas e saída normalizada versionadas. */
const IdentityAdapter = definePort('IdentityAdapter', 'IDENTITY', {
  verifyToken: ['token'],
  getUserInfo: ['token'],
  revokeSession: ['sessionId'],
  listJwks: [],
});

module.exports = { IdentityAdapter };
