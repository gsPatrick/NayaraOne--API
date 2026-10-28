'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { contentInvalid } = require('./pipeline.errors');

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?$/;

/** Fuso da empresa (parâmetro de horário de silêncio do Marketing, M9-D417; padrão America/Sao_Paulo). */
async function companyTimeZone(tenant, transaction) {
  const { cadence } = require('../automations'); // require tardio: evita ciclo de carga entre as áreas
  return (await cadence.getMarketingParam(cadence.QUIET_HOURS_KEY, tenant, transaction)).timeZone;
}

/** Instante do agendamento: com fuso vale o informado; SEM fuso é horário da empresa (convertido pelo banco). Inválido: 400. */
async function parseWhen(value, tenant, transaction) {
  const invalid = () => contentInvalid('Informe a data e hora do agendamento (campo when).', { field: 'when' });
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalid();
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) throw invalid();
  const text = value.trim();
  if (HAS_OFFSET.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw invalid();
    return date;
  }
  if (!NAIVE.test(text)) throw invalid();
  const [row] = await sequelize.query('SELECT ((:text)::timestamp AT TIME ZONE :zone) AS instant', {
    replacements: { text: text.replace('T', ' '), zone: await companyTimeZone(tenant, transaction) }, transaction, type: QueryTypes.SELECT,
  });
  return new Date(row.instant);
}

module.exports = { parseWhen };
