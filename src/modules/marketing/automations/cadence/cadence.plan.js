'use strict';

const { getMarketingParam } = require('./marketingParam.service');

function toDateOnly(base) {
  if (base instanceof Date && !Number.isNaN(base.getTime())) return base.toISOString().slice(0, 10);
  if (typeof base === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(base)) return base;
  throw new Error('Data-base da cadência inválida: use AAAA-MM-DD ou Date.');
}

function addDays(dateOnly, days) {
  const d = new Date(`${dateOnly}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Planeja as datas de uma cadência com o valor vigente do parâmetro `code` (dias corridos a partir da data-base). Devolve um
 * retrato congelado: quem agenda grava `dueDate` e `offsetDays` na criação da ação; alterar o parâmetro depois NÃO move ações já
 * agendadas, só os planos novos (M9-D417 §3.6).
 */
async function planCadence(code, baseDate, tenant, transaction) {
  const base = toDateOnly(baseDate);
  const days = await getMarketingParam(code, tenant, transaction);
  return Object.freeze(days.map((offsetDays) => Object.freeze({ code, offsetDays, dueDate: addDays(base, offsetDays) })));
}

module.exports = { planCadence, addDays };
