'use strict';

const crypto = require('node:crypto');
const { mktError } = require('../marketing.errors');

/**
 * M9-D419 regra 3 — identificador pseudonimizado da pessoa nas métricas: person_hash = sha256(person_id + ':' + segredo), em
 * hexadecimal minúsculo. O segredo (`marketing.person_hash_salt`) mora no COFRE, um por empresa, em
 * `company/<id>/marketing/person-hash-salt`: é criado na primeira necessidade, nunca vai para arquivo, log ou configuração, e por ser
 * fixo o hash é estável por empresa (e diferente entre empresas para a mesma pessoa).
 */
const saltRef = (companyId) => `company/${companyId}/marketing/person-hash-salt`;

async function personHashSalt(tenant) {
  const { getSecretStore } = require('../../../features/integrations/secrets');
  try {
    const store = getSecretStore();
    const ref = saltRef(tenant.companyId);
    try {
      return (await store.get(ref)).value.reveal();
    } catch (err) {
      if (err.code !== 'INTEGRATION_SECRET_NOT_FOUND') throw err;
      await store.put(ref, crypto.randomBytes(32).toString('hex'), {});
      return (await store.get(ref)).value.reveal();
    }
  } catch (err) {
    throw mktError(503, 'MKT_PERSON_HASH_UNAVAILABLE', 'O cofre de segredos está indisponível; tente de novo.');
  }
}

/** person_hash de uma pessoa da empresa (64 caracteres hexadecimais). */
async function personHash(personId, tenant) {
  return crypto.createHash('sha256').update(`${personId}:${await personHashSalt(tenant)}`).digest('hex');
}

module.exports = { personHash, personHashSalt, saltRef };
