'use strict';

/**
 * M9-D624 — peças comuns das fórmulas dos KPIs de conciliações e anomalias: mensagem de dado incompleto, resultado DEGRADED (valor nulo,
 * nunca número enganoso) e idade em dias corridos entre duas datas de calendário.
 */
const { daysBetween } = require('./_dates');

const INCOMPLETE_MESSAGE = 'Dado incompleto, valor não confiável.';

/** Resultado de qualidade violada: sem valor, com o motivo e (opcional) os detalhes que continuam verdadeiros. */
function degraded(reason, details = {}, dimensions = []) {
  return { value: null, status: 'DEGRADED', message: INCOMPLETE_MESSAGE, details: { reason, ...details }, dimensions };
}

/** Idade, em dias, da data mais antiga em relação à data-base; nulo quando não há registro. */
const ageDays = (oldestDate, asOfDate) => (oldestDate ? String(daysBetween(oldestDate, asOfDate)) : null);

module.exports = { INCOMPLETE_MESSAGE, degraded, ageDays };
