'use strict';

/**
 * M9-D423 — parâmetros da série de lembretes de restrição e regularização (aba Marketing): de quantos em quantos dias o lembrete sai e quantos dias depois da abertura
 * a série expira (cria a tarefa ao responsável e para).
 */
const INTERVAL_KEY = 'marketing.restricao.intervalo_dias';
const EXPIRATION_KEY = 'marketing.restricao.expiracao_dias';
const RESTRICAO_DEFAULTS = Object.freeze({ [INTERVAL_KEY]: 7, [EXPIRATION_KEY]: 60 });
const RESTRICAO_SETTINGS_SCHEMA = {
  [INTERVAL_KEY]: { type: 'integer', min: 1, max: 365 },
  [EXPIRATION_KEY]: { type: 'integer', min: 1, max: 3650 },
};

async function readRestricaoParams(tenant, transaction) {
  const { getSetting } = require('../../../settings/settings.service'); // leitura tardia: o dicionário de parâmetros carrega este arquivo
  const [interval, expiration] = await Promise.all([INTERVAL_KEY, EXPIRATION_KEY].map((key) => getSetting(key, tenant, transaction, RESTRICAO_DEFAULTS[key])));
  const valid = (v, key) => (Number.isInteger(v) && v >= 1 ? v : RESTRICAO_DEFAULTS[key]);
  return { intervalDays: valid(interval, INTERVAL_KEY), expirationDays: valid(expiration, EXPIRATION_KEY) };
}

module.exports = { INTERVAL_KEY, EXPIRATION_KEY, RESTRICAO_DEFAULTS, RESTRICAO_SETTINGS_SCHEMA, readRestricaoParams };
