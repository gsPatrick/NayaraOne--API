'use strict';

const { getSetting } = require('../../../settings/settings.service');

/** Padrões do livro (reserva de 20%); a espera quando a cota esgota sem data de renovação é a decisão DI-D218-3. */
const PADROES = Object.freeze({ reservePct: 20, fallbackWaitS: 300 });

const inteiro = (v, padrao, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : padrao);

async function readQuotaParams(ctx, transaction) {
  const [reserva, espera] = await Promise.all([
    getSetting('integration.rate_limit.reserve_pct', ctx, transaction, PADROES.reservePct),
    getSetting('integration.rate_limit.fallback_wait_s', ctx, transaction, PADROES.fallbackWaitS),
  ]);
  return { reservePct: inteiro(reserva, PADROES.reservePct, 0, 100), fallbackWaitS: inteiro(espera, PADROES.fallbackWaitS, 1, 86400) };
}

module.exports = { PADROES, readQuotaParams };
