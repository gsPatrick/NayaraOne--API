'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

/** Segredo e identificador da credencial (M9-D844 §3.1). O segredo só existe em claro na criação; o banco guarda o hash bcrypt. */
const newClientId = () => `nyc_${crypto.randomBytes(12).toString('hex')}`;
const newSecret = () => `nys_${crypto.randomBytes(32).toString('base64url')}`;
const hashSecret = (secret, cost) => bcrypt.hash(secret, cost);

// Hash de uma credencial que não existe: a conferência gasta o mesmo tempo e o erro não revela se o client_id existe.
const DUMMY_HASH = bcrypt.hashSync('nenhum-segredo-usa-este-valor', 10);

async function verifySecret(secret, hash) {
  const ok = await bcrypt.compare(String(secret), hash || DUMMY_HASH);
  return Boolean(hash) && ok;
}

module.exports = { newClientId, newSecret, hashSecret, verifySecret };
