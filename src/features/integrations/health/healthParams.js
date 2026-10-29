'use strict';

const { getSetting } = require('../../settings/settings.service');
const { parseSlo, DEFAULT_SLO, DEFAULT_SLO_TEXT } = require('./sloParse');

/** Leitura dos parâmetros de saúde, com o padrão do parametros.csv quando a empresa não configurou (ou o valor gravado é inválido). */
const PADROES = Object.freeze({ staleAfterS: 180, aggregateIntervalS: 60, retentionDays: 30, downAfterFailures: 3, checkIntervalS: 60 });
const CRITICIDADES = Object.keys(DEFAULT_SLO_TEXT);

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readHealthParams(ctx, transaction) {
  const [stale, intervalo, retencao, falhas, checagem, ...slos] = await Promise.all([
    getSetting('integration.health.stale_after_s', ctx, transaction, PADROES.staleAfterS),
    getSetting('integration.health.aggregate_interval_s', ctx, transaction, PADROES.aggregateIntervalS),
    getSetting('integration.health.history_retention_days', ctx, transaction, PADROES.retentionDays),
    getSetting('integration.health.down_after_failures', ctx, transaction, PADROES.downAfterFailures),
    getSetting('integration.health.check_interval_s', ctx, transaction, PADROES.checkIntervalS),
    ...CRITICIDADES.map((c) => getSetting(`integration.slo.${c}`, ctx, transaction, DEFAULT_SLO_TEXT[c])),
  ]);
  return {
    staleAfterS: inteiro(stale, PADROES.staleAfterS, 1),
    aggregateIntervalS: inteiro(intervalo, PADROES.aggregateIntervalS, 1),
    retentionDays: inteiro(retencao, PADROES.retentionDays, 1),
    downAfterFailures: inteiro(falhas, PADROES.downAfterFailures, 1),
    checkIntervalS: inteiro(checagem, PADROES.checkIntervalS, 1),
    slo: Object.fromEntries(CRITICIDADES.map((c, i) => [c, parseSlo(slos[i]) || DEFAULT_SLO[c]])),
  };
}

module.exports = { PADROES, readHealthParams };
