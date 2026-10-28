'use strict';

const { getSetting } = require('../../settings/settings.service');

/** Leitura dos parâmetros de erros, com o padrão do parametros.csv quando a empresa não configurou. */
const PADROES = Object.freeze({ groupWindowMin: 10, retentionDays: 180, exhaustedAttempts: 5 });

const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

async function readErrorParams(ctx, transaction) {
  const [janela, retencao, esgotadas] = await Promise.all([
    getSetting('integration.errors.group_window_min', ctx, transaction, PADROES.groupWindowMin),
    getSetting('integration.errors.retention_days', ctx, transaction, PADROES.retentionDays),
    getSetting('integration.errors.exhausted_attempts', ctx, transaction, PADROES.exhaustedAttempts),
  ]);
  return {
    groupWindowMin: inteiro(janela, PADROES.groupWindowMin, 1),
    retentionDays: inteiro(retencao, PADROES.retentionDays, 1),
    exhaustedAttempts: inteiro(esgotadas, PADROES.exhaustedAttempts, 1),
  };
}

module.exports = { PADROES, readErrorParams };
