'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../models');
const { validation } = require('./campaigns.errors');

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?$/;

/**
 * Fuso da empresa para datas sem fuso: o mesmo do horário de silêncio do Marketing (parâmetro `marketing.quiet_hours`, M9-D417;
 * o padrão do livro é America/Sao_Paulo). Nunca o fuso do servidor.
 */
async function companyTimeZone(tenant, transaction) {
  const { cadence } = require('../automations'); // require tardio: evita ciclo de carga entre as áreas
  return (await cadence.getMarketingParam(cadence.QUIET_HOURS_KEY, tenant, transaction)).timeZone;
}

/**
 * Converte o instante informado pela API. Com fuso (Z ou +hh:mm) vale o fuso informado; SEM fuso é horário da empresa
 * (convertido pelo banco). Inválido: 400 MKT_CAMPAIGN_VALIDATION.
 */
async function parseInstant(value, field, tenant, transaction) {
  const invalid = () => validation(`Informe ${field} como data e hora válidas.`, { field });
  if (typeof value !== 'string' || !value.trim()) throw invalid();
  const text = value.trim();
  if (HAS_OFFSET.test(text)) {
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) throw invalid();
    return date;
  }
  if (!NAIVE.test(text)) throw invalid();
  const probe = new Date(`${text.replace(' ', 'T')}${text.length === 10 ? 'T00:00:00' : ''}Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== text.slice(0, 10)) throw invalid();
  const [row] = await sequelize.query('SELECT ((:text)::timestamp AT TIME ZONE :zone) AS instant', {
    replacements: { text: text.replace('T', ' '), zone: await companyTimeZone(tenant, transaction) }, transaction, type: QueryTypes.SELECT,
  });
  return new Date(row.instant);
}

module.exports = { parseInstant, companyTimeZone };
