'use strict';

const { divHalfEven, safeNumber } = require('../money');
const { detectSpike, scaledText } = require('./spike');
const { dayAndHistory } = require('./volume.series');

/**
 * Logs excessivos (M9-D862 §3.2): o volume diário de log do ambiente é a linha `service = 'logs'` do ledger (gravada pelo coletor de storage da M9-D860, em GB).
 * Acima de `log_x_media` vezes a média móvel dos `media_dias` dias anteriores abre o achado. Desperdício = (volume do dia - média) x preço do GB de log
 * (`logs_gb_mes` de `governanca.finops.precos`). Dia que o coletor não mediu não tem linha: sem achado.
 */
async function detectLogVolume(tenant, day, params, transaction) {
  const price = params.finops.prices.logs_gb_mes;
  const { today, history } = await dayAndHistory(tenant, { category: 'STORAGE', unit: 'GB', service: 'logs', environment: params.finops.environment }, day, params.averageDays, transaction);
  if (today === undefined) return [];
  const spike = detectSpike(today, history, params.logFactor);
  if (!spike) return [];
  const waste = price === undefined ? 0n : divHalfEven(spike.excess * price, 1000000000000n);
  return [{
    subject: `logs:${params.finops.environment}`, wasteCents: safeNumber(waste),
    evidence: { day, volumeGb: scaledText(today), averageGb: scaledText(spike.average), diasNaMedia: history.length, vezesAMedia: Number(divHalfEven(today * 100n, spike.average)) / 100, limiarVezes: params.logFactor },
  }];
}

module.exports = { detectLogVolume };
