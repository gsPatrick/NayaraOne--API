'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do livro (M9-D232 3.4): leitura do status a cada 15 minutos; página de 50 anúncios. */
const PADROES = Object.freeze({ reconcileIntervalMin: 15, syncPageSize: 50 });

const inteiro = (v, padrao, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : padrao);

async function readPortalParams(ctx, transaction) {
  const [intervalo, pagina] = await Promise.all([
    getSetting('integration.portal.reconcile_interval_min', ctx, transaction, PADROES.reconcileIntervalMin),
    getSetting('integration.portal.sync_page_size', ctx, transaction, PADROES.syncPageSize),
  ]);
  return { reconcileIntervalMin: inteiro(intervalo, PADROES.reconcileIntervalMin, 1, 1440), syncPageSize: inteiro(pagina, PADROES.syncPageSize, 5, 500) };
}

module.exports = { PADROES, readPortalParams };
