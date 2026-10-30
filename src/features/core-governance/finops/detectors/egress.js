'use strict';

const { divHalfEven, safeNumber } = require('../money');
const { detectSpike, scaledText } = require('./spike');
const { dayAndHistory } = require('./volume.series');

/**
 * Egress anormal (M9-D862 §3.5): bytes de saída do dia (linhas EGRESS do ledger, em bytes) acima de `egress_x_media` vezes a média móvel dos `media_dias` dias
 * anteriores. Desperdício = (bytes do dia - média) x preço do GB de saída (`egress_gb`). Exemplo: média 2 GB, hoje 7 GB (3,5x) abre o achado.
 */
async function detectEgress(tenant, day, params, transaction) {
  const price = params.finops.prices.egress_gb;
  const { today, history } = await dayAndHistory(tenant, { category: 'EGRESS', unit: 'bytes', environment: params.finops.environment }, day, params.averageDays, transaction);
  if (today === undefined) return [];
  const spike = detectSpike(today, history, params.egressFactor);
  if (!spike) return [];
  const waste = price === undefined ? 0n : divHalfEven(spike.excess * price, params.finops.gbBase ** 3n * 1000000000000n);
  return [{
    subject: `egress:${params.finops.environment}`, wasteCents: safeNumber(waste),
    evidence: { day, bytesHoje: scaledText(today).replace('.000000', ''), bytesMedia: scaledText(spike.average).replace(/\.\d+$/, ''), diasNaMedia: history.length, vezesAMedia: Number(divHalfEven(today * 100n, spike.average)) / 100, limiarVezes: params.egressFactor },
  }];
}

module.exports = { detectEgress };
