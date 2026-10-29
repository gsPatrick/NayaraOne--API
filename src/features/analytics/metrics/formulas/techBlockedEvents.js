'use strict';

/**
 * M9-D680 — KPI tec.blocked_events (Eventos bloqueados), versão 1. Posição no dia-base de São Paulo: contagem de eventos barrados por motivo (kill switch, política de segurança, falta
 * de consentimento, validação). O valor é o total; cada motivo conhecido (analytics.tec.motivos_bloqueio_conhecidos) tem a sua dimensão, mesmo zerada; os desconhecidos somam em
 * `details.other` (e em `outro_qtd`). Exemplo: kill switch 0; consentimento 14; validação 3. Entrada (rm_tech_blocked_events): { rows: [{ reason, eventType, blocked }] }. Parâmetro:
 * knownReasons. Regra de qualidade: evento bloqueado sem motivo (NO_REASON) -> DEGRADED e sem valor.
 */
const money = require('./money');
const { degraded, sumCounts, byText } = require('./_legalCorKpi');

const NO_REASON = 'NO_REASON';
const DEFAULT_KNOWN = ['KILL_SWITCH', 'SECURITY_POLICY', 'CONSENT', 'VALIDATION'];

function compute(input, params = {}) {
  const rows = input.rows || [];
  const known = Array.isArray(params.knownReasons) && params.knownReasons.length ? params.knownReasons : DEFAULT_KNOWN;
  const noReason = sumCounts(rows.filter((r) => r.reason === NO_REASON).map((r) => r.blocked));
  if (money.cmp(noReason, 0) > 0) return degraded('EVENTO_BLOQUEADO_SEM_MOTIVO', { withoutReason: noReason });
  const total = sumCounts(rows.map((r) => r.blocked));
  const countOf = (reason) => sumCounts(rows.filter((r) => r.reason === reason).map((r) => r.blocked));
  const dimensions = known.map((reason) => ({ key: `motivo:${reason}:bloqueados_qtd`, value: countOf(reason) }));
  const otherRows = rows.filter((r) => !known.includes(r.reason));
  const other = Object.fromEntries([...new Set(otherRows.map((r) => r.reason))].sort(byText).map((reason) => [reason, countOf(reason)]));
  const otherTotal = sumCounts(otherRows.map((r) => r.blocked));
  dimensions.push({ key: 'outro_qtd', value: otherTotal });
  for (const type of [...new Set(rows.map((r) => r.eventType))].sort(byText)) dimensions.push({ key: `tipo:${type}:bloqueados_qtd`, value: sumCounts(rows.filter((r) => r.eventType === type).map((r) => r.blocked)) });
  return { value: total, status: 'OK', details: { blocked: total, byReason: Object.fromEntries(known.map((reason) => [reason, countOf(reason)])), other }, dimensions };
}

const row = (reason, eventType, blocked) => ({ reason, eventType, blocked });
const dimsOf = (counts, other, types) => [
  { key: 'motivo:KILL_SWITCH:bloqueados_qtd', value: counts[0] }, { key: 'motivo:SECURITY_POLICY:bloqueados_qtd', value: counts[1] }, { key: 'motivo:CONSENT:bloqueados_qtd', value: counts[2] },
  { key: 'motivo:VALIDATION:bloqueados_qtd', value: counts[3] }, { key: 'outro_qtd', value: other }, ...types.map(([t, n]) => ({ key: `tipo:${t}:bloqueados_qtd`, value: n })),
];

const testCases = [
  {
    kind: 'empty', name: 'nenhum evento bloqueado no dia: zero em cada motivo, não nulo', input: { rows: [] },
    expected: { value: '0', status: 'OK', details: { blocked: '0', byReason: { KILL_SWITCH: '0', SECURITY_POLICY: '0', CONSENT: '0', VALIDATION: '0' }, other: {} }, dimensions: dimsOf(['0', '0', '0', '0'], '0', []) },
  },
  {
    kind: 'single', name: 'um evento bloqueado por política de segurança', input: { rows: [row('SECURITY_POLICY', 'finance.transfer.blocked', 1)] },
    expected: {
      value: '1', status: 'OK', details: { blocked: '1', byReason: { KILL_SWITCH: '0', SECURITY_POLICY: '1', CONSENT: '0', VALIDATION: '0' }, other: {} },
      dimensions: dimsOf(['0', '1', '0', '0'], '0', [['finance.transfer.blocked', '1']]),
    },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: kill switch 0; consentimento 14; validação 3', input: { rows: [row('CONSENT', 'marketing.automation_run', 14), row('VALIDATION', 'integration.dispatch:publishListing', 3)] },
    expected: {
      value: '17', status: 'OK', details: { blocked: '17', byReason: { KILL_SWITCH: '0', SECURITY_POLICY: '0', CONSENT: '14', VALIDATION: '3' }, other: {} },
      dimensions: dimsOf(['0', '0', '14', '3'], '0', [['integration.dispatch:publishListing', '3'], ['marketing.automation_run', '14']]),
    },
  },
  {
    kind: 'period_edge', name: 'motivo desconhecido soma em other; evento sem motivo deixa DEGRADED e sem valor', input: { rows: [row('QUIET_HOURS', 'marketing.automation_run', 5), row('FREQUENCY_CAP', 'marketing.automation_run', 2), row('CONSENT', 'marketing.automation_run', 1)] },
    expected: {
      value: '8', status: 'OK', details: { blocked: '8', byReason: { KILL_SWITCH: '0', SECURITY_POLICY: '0', CONSENT: '1', VALIDATION: '0' }, other: { FREQUENCY_CAP: '2', QUIET_HOURS: '5' } },
      dimensions: dimsOf(['0', '0', '1', '0'], '7', [['marketing.automation_run', '8']]),
    },
  },
  {
    kind: 'period_edge', name: 'evento bloqueado sem motivo: DEGRADED e sem valor', input: { rows: [row('NO_REASON', 'marketing.automation_run', 1), row('CONSENT', 'marketing.automation_run', 4)] },
    expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'EVENTO_BLOQUEADO_SEM_MOTIVO', withoutReason: '1' }, dimensions: [] },
  },
  {
    kind: 'rounding', name: 'os motivos conhecidos são parâmetro; contagens grandes somam exatas', input: { rows: [row('CONSENT', 'a', '9007199254740993'), row('KILL_SWITCH', 'a', 1)] }, params: { knownReasons: ['CONSENT'] },
    expected: {
      value: '9007199254740994', status: 'OK', details: { blocked: '9007199254740994', byReason: { CONSENT: '9007199254740993' }, other: { KILL_SWITCH: '1' } },
      dimensions: [{ key: 'motivo:CONSENT:bloqueados_qtd', value: '9007199254740993' }, { key: 'outro_qtd', value: '1' }, { key: 'tipo:a:bloqueados_qtd', value: '9007199254740994' }],
    },
  },
];

module.exports = { id: 'tec.blocked_events', version: 1, compute, testCases };
