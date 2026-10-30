'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Padrões do livro (M9-D255 3.3: 50 webhooks/s e 20 envios/s por 5 min) e do parametros.csv, usados quando a empresa não configurou. */
const PADROES = Object.freeze({ webhooksPerS: 50, dispatchesPerS: 20, durationMin: 5, duplicatePercent: 10, concurrency: 20 });

const faixa = (v, padrao, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : padrao);

async function readLoadParams(tenant, transaction) {
  const [w, d, m, p, c] = await Promise.all([
    getSetting('integration.load.webhooks_per_s', tenant, transaction, PADROES.webhooksPerS),
    getSetting('integration.load.dispatches_per_s', tenant, transaction, PADROES.dispatchesPerS),
    getSetting('integration.load.duration_min', tenant, transaction, PADROES.durationMin),
    getSetting('integration.load.duplicate_percent', tenant, transaction, PADROES.duplicatePercent),
    getSetting('integration.load.concurrency', tenant, transaction, PADROES.concurrency),
  ]);
  return {
    webhooksPerS: faixa(w, PADROES.webhooksPerS, 1, 1000),
    dispatchesPerS: faixa(d, PADROES.dispatchesPerS, 1, 1000),
    durationMin: faixa(m, PADROES.durationMin, 1, 60),
    duplicatePercent: faixa(p, PADROES.duplicatePercent, 0, 90),
    concurrency: faixa(c, PADROES.concurrency, 1, 200),
  };
}

/** Tamanho da carga: webhooks e envios = taxa × duração; repetidos = percentual do total (os distintos são o resto). */
function loadVolume(params) {
  const total = (porSegundo) => porSegundo * 60 * params.durationMin;
  const split = (n) => { const repetidos = Math.floor((n * params.duplicatePercent) / 100); return { total: n, repetidos, distintos: n - repetidos }; };
  return { webhooks: split(total(params.webhooksPerS)), dispatches: split(total(params.dispatchesPerS)), concurrency: params.concurrency };
}

module.exports = { PADROES, readLoadParams, loadVolume };
