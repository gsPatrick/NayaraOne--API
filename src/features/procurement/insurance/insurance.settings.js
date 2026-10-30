'use strict';

const AppError = require('../../../utils/AppError');

/** Lista de dias inteiros positivos separados por vírgula (ex.: 60,30,15,7), de 1 a 10 valores, sem repetição, até 730 dias. Devolve a lista em ordem decrescente ou null. */
function parseDays(texto) {
  if (typeof texto !== 'string' || !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(texto)) return null;
  const lista = [...new Set(texto.split(',').map((x) => Number(x.trim())))];
  return lista.length >= 1 && lista.length <= 10 && lista.every((n) => Number.isInteger(n) && n >= 1 && n <= 730) ? lista.sort((a, b) => b - a) : null;
}

/** Parâmetros das seguradoras (M9-D238): só o dicionário de SETTINGS_SCHEMA; a leitura está em insurance.params.js. */
const INSURANCE_SETTINGS_SCHEMA = Object.freeze({
  // INT-P084: dias antes do fim da vigência em que a apólice publica `insurance.policy.expiring` (um marco por faixa, uma vez por vigência).
  'integration.insurance.renewal_alert_days': {
    type: 'string',
    validate: (key, value) => {
      if (!parseDays(value)) throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 10 dias inteiros positivos separados por vírgula (ex.: 60,30,15,7).`, 'SETTING_INVALID_VALUE', { key, value });
    },
  },
  // Livro: "a renovação inicia nova cotação pelo mesmo adapter". Ligado, a cotação de renovação sai sozinha quando a apólice entra no marco abaixo.
  'integration.insurance.renewal_quote_enabled': { type: 'boolean' },
  // Quantos dias antes do fim da vigência a cotação de renovação é pedida (a primeira faixa de alerta que chegar a esse prazo).
  'integration.insurance.renewal_quote_days': { type: 'integer', min: 1, max: 365 },
  // Prazo, em dias, da tarefa manual quando a seguradora não tem API (cotação por e-mail ou portal).
  'integration.insurance.manual_task_due_days': { type: 'integer', min: 1, max: 60 },
});

module.exports = { INSURANCE_SETTINGS_SCHEMA, parseDays };
