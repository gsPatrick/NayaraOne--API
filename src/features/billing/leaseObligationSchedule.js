'use strict';

const AppError = require('../../utils/AppError');
const { getSetting } = require('../settings/settings.service');

/**
 * Fechamento M5 (Caderno §12 "Cada obrigação possui responsável, periodicidade, comprovante e status").
 * Periodicidade informada na criação ou, se ausente, o padrão configurado por tipo
 * (`locacao.obrigacoes.periodicidade.<TIPO>`): IPTU e SPU anuais (lançamento anual por lei), as demais mensais.
 */
const PERIODICITIES = ['MONTHLY', 'BIMONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONE_TIME'];
const MONTHS = { MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12, ONE_TIME: 0 };
const DEFAULT_BY_TYPE = { IPTU: 'ANNUAL', SPU: 'ANNUAL' };

async function resolvePeriodicity(utilityType, payload, tenant, transaction) {
  const asked = payload && payload.periodicity ? String(payload.periodicity).toUpperCase() : null;
  if (asked && !PERIODICITIES.includes(asked)) {
    throw AppError.badRequest(`"periodicity" deve ser um de: ${PERIODICITIES.join(', ')}.`, 'UTILITY_OBLIGATION_VALIDATION');
  }
  const configured = await getSetting(`locacao.obrigacoes.periodicidade.${utilityType}`, tenant, transaction, null);
  const periodicity = asked || (PERIODICITIES.includes(configured) ? configured : DEFAULT_BY_TYPE[utilityType] || 'MONTHLY');
  let dueDay = null;
  if (payload && payload.dueDay !== undefined && payload.dueDay !== null && payload.dueDay !== '') {
    dueDay = Number(payload.dueDay);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      throw AppError.badRequest('"dueDay" (dia do vencimento) deve ser um inteiro de 1 a 31.', 'UTILITY_OBLIGATION_VALIDATION');
    }
  }
  return { periodicity, dueDay };
}

/** Próximo vencimento a partir do início (data da entrega das chaves), em AAAA-MM-DD. */
function nextDueDate(startsOn, periodicity, dueDay) {
  const [y, m, d] = String(startsOn).slice(0, 10).split('-').map(Number);
  const step = MONTHS[periodicity] === undefined ? 1 : MONTHS[periodicity];
  if (step === 0) return String(startsOn).slice(0, 10);
  const day = dueDay || d;
  let month = m - 1;
  let year = y;
  if (day <= d) month += step; // o vencimento do mês da entrega já passou ou é hoje: vai para o próximo ciclo
  year += Math.floor(month / 12);
  month %= 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

module.exports = { resolvePeriodicity, nextDueDate, PERIODICITIES };
