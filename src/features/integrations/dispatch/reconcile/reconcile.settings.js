'use strict';

const AppError = require('../../../../utils/AppError');

/** Lista de segundos inteiros positivos separados por vírgula (ex.: 30,120,600). Devolve a lista ou null. */
function parseIntervals(texto) {
  if (typeof texto !== 'string' || !/^\s*\d+(\s*,\s*\d+)*\s*$/.test(texto)) return null;
  const lista = texto.split(',').map((x) => Number(x.trim()));
  return lista.length >= 1 && lista.length <= 20 && lista.every((n) => Number.isInteger(n) && n >= 1 && n <= 604800) ? lista : null;
}

/** Parâmetros da reconciliação de envios incertos (M9-D215): só o dicionário de SETTINGS_SCHEMA; a leitura está em reconcile.params.js. */
const RECONCILE_SETTINGS_SCHEMA = Object.freeze({
  // INT-P007: consultas ao fornecedor antes de mandar o envio incerto para a fila morta (revisão humana).
  'integration.unknown.max_reconcile_attempts': { type: 'integer', min: 1, max: 20 },
  // INT-P008: esperas (segundos) antes de cada consulta; a última se repete se houver mais consultas que esperas.
  'integration.unknown.reconcile_intervals_s': {
    type: 'string',
    validate: (key, value) => {
      if (!parseIntervals(value)) {
        throw AppError.badRequest(`O valor de "${key}" deve ser uma lista de 1 a 20 segundos inteiros positivos separados por vírgula (ex.: 30,120,600,3600,21600).`, 'SETTING_INVALID_VALUE', { key, value });
      }
    },
  },
  // M9-D215: de quantos em quantos segundos o job de reconciliação confere os envios incertos devidos (a espera de cada um é a de cima).
  'integration.unknown.reconcile_job_interval_s': { type: 'integer', min: 1, max: 3600 },
  // M9-D215 3.4: de quantos em quantos segundos o recuperador procura envios presos em SENDING (o limite de "preso" é integration.dispatch.sending_stale_s).
  'integration.dispatch.orphan_interval_s': { type: 'integer', min: 5, max: 3600 },
});

module.exports = { RECONCILE_SETTINGS_SCHEMA, parseIntervals };
