'use strict';

/** Validação de JWT e cache de JWKS que os adapters de identidade usam (o núcleo mora em src/shared/identity, sem dependência de feature). */
const { verifyJwtStrict, peekHeader } = require('../../../../shared/identity/jwtStrict');
const { createJwksCache } = require('../../../../shared/identity/jwksCache');

module.exports = { verifyJwtStrict, peekHeader, createJwksCache };
