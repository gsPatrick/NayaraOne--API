'use strict';

/**
 * M9-D671 — KPI mkt.automations_blocked_failed (Automações bloqueadas e com falha), versão 1. Fluxo no mês de São Paulo da data-base: execuções totais (o
 * valor), bloqueadas (por `blocked_reason`; quiet hours é adiamento e não entra) e com falha (por código de erro), com o percentual de cada uma sobre o total
 * (2 casas), por automação e motivo. Nenhuma execução = INCOMPLETE; execução bloqueada sem motivo (regra de qualidade) ou read model ainda não recalculado =
 * DEGRADED; ambos sem valor. Entrada (rm_mkt_automation dos dias do mês): { rows: [{ executed, failed, blockedWithoutReason, blockedByReason, failedByCode,
 * byAutomation }] }.
 */
const money = require('./money');
const { sumCounts, groupSum, pct, degraded, incomplete, byText } = require('./_mktKpi');

/** Soma os mapas { chave: quantidade } de várias linhas; devolve [[chave, quantidade]] ordenado pela chave. */
const mergeCounts = (maps) => groupSum(maps.flatMap((m) => Object.entries(m || {}).map(([k, n]) => ({ k, n }))), (e) => e.k, ['n']).map(([k, v]) => [k, v.n]);

function compute(input) {
  const rows = input.rows || [];
  if (rows.some((r) => r.blockedByReason === null || r.blockedByReason === undefined || r.failedByCode === null || r.failedByCode === undefined || r.byAutomation === null || r.byAutomation === undefined)) return degraded('READ_MODEL_NAO_RECALCULADO', {});
  const total = sumCounts(rows.map((r) => r.executed));
  const withoutReason = sumCounts(rows.map((r) => r.blockedWithoutReason));
  const byReason = mergeCounts(rows.map((r) => r.blockedByReason));
  const blocked = money.count(money.add(sumCounts(byReason.map(([, n]) => n)), withoutReason));
  const failed = sumCounts(rows.map((r) => r.failed));
  const details = { total, blocked, failed, blockedPct: pct(blocked, total), failedPct: pct(failed, total) };
  if (money.cmp(withoutReason, 0) > 0) return degraded('BLOQUEIO_SEM_MOTIVO', { total, blocked, failed, blockedWithoutReason: withoutReason });
  if (money.cmp(total, 0) === 0) return incomplete('SEM_EXECUCAO_NO_PERIODO', { total, blocked, failed });
  const byCode = mergeCounts(rows.map((r) => r.failedByCode));
  const flows = new Map();
  for (const r of rows) for (const [id, v] of Object.entries(r.byAutomation)) {
    const acc = flows.get(id) || { executed: '0', blocked: '0', failed: '0' };
    flows.set(id, { executed: money.count(money.add(acc.executed, v.executed)), blocked: money.count(money.add(acc.blocked, v.blocked)), failed: money.count(money.add(acc.failed, v.failed)) });
  }
  const byAutomation = [...flows.entries()].sort((a, b) => byText(a[0], b[0])).map(([automation, v]) => ({ automation, ...v }));
  const dimensions = [{ key: 'bloqueadas_qtd', value: blocked }, { key: 'bloqueadas_pct', value: details.blockedPct }, { key: 'falhas_qtd', value: failed }, { key: 'falhas_pct', value: details.failedPct }];
  for (const [reason, n] of byReason) dimensions.push({ key: `motivo:${reason}:bloqueadas_qtd`, value: n });
  for (const [code, n] of byCode) dimensions.push({ key: `erro:${code}:falhas_qtd`, value: n });
  for (const a of byAutomation) dimensions.push({ key: `automacao:${a.automation}:bloqueadas_qtd`, value: a.blocked }, { key: `automacao:${a.automation}:falhas_qtd`, value: a.failed });
  return {
    value: total, status: 'OK',
    details: { ...details, byReason: byReason.map(([reason, n]) => ({ reason, count: n })), byErrorCode: byCode.map(([code, n]) => ({ code, count: n })), byAutomation },
    dimensions,
  };
}

const row = (executed, failed, blockedByReason, failedByCode, byAutomation, extra = {}) => ({ executed, failed, blockedWithoutReason: 0, blockedByReason, failedByCode, byAutomation, ...extra });
const bad = (status, reason, details) => ({ value: null, status, message: 'Dado incompleto, valor não confiável.', details: { reason, ...details }, dimensions: [] });

const testCases = [
  { kind: 'empty', name: 'nenhuma execução no mês: INCOMPLETE e sem valor', input: { rows: [] }, expected: bad('INCOMPLETE', 'SEM_EXECUCAO_NO_PERIODO', { total: '0', blocked: '0', failed: '0' }) },
  {
    kind: 'single', name: 'uma execução com falha de adapter: 100,00% de falhas',
    input: { rows: [row(1, 1, {}, { ADAPTER_TIMEOUT: 1 }, { f1: { executed: 1, blocked: 0, failed: 1 } })] },
    expected: {
      value: '1', status: 'OK', details: { total: '1', blocked: '0', failed: '1', blockedPct: '0.00', failedPct: '100.00', byReason: [], byErrorCode: [{ code: 'ADAPTER_TIMEOUT', count: '1' }], byAutomation: [{ automation: 'f1', executed: '1', blocked: '0', failed: '1' }] },
      dimensions: [{ key: 'bloqueadas_qtd', value: '0' }, { key: 'bloqueadas_pct', value: '0.00' }, { key: 'falhas_qtd', value: '1' }, { key: 'falhas_pct', value: '100.00' }, { key: 'erro:ADAPTER_TIMEOUT:falhas_qtd', value: '1' }, { key: 'automacao:f1:bloqueadas_qtd', value: '0' }, { key: 'automacao:f1:falhas_qtd', value: '1' }],
    },
  },
  {
    kind: 'typical', name: 'exemplo da demanda: total 500; bloqueadas 14 (2,80%); falhas 6 (1,20%); soma de dois dias, motivos e automações',
    input: { rows: [row(300, 4, { NO_CONSENT: 6, FREQUENCY_CAP: 2 }, { ADAPTER_TIMEOUT: 3, SEM_CODIGO: 1 }, { f1: { executed: 200, blocked: 6, failed: 4 }, f2: { executed: 100, blocked: 2, failed: 0 } }), row(200, 2, { NO_CONSENT: 6 }, { ADAPTER_TIMEOUT: 2 }, { f1: { executed: 200, blocked: 6, failed: 2 } })] },
    expected: {
      value: '500', status: 'OK',
      details: { total: '500', blocked: '14', failed: '6', blockedPct: '2.80', failedPct: '1.20', byReason: [{ reason: 'FREQUENCY_CAP', count: '2' }, { reason: 'NO_CONSENT', count: '12' }], byErrorCode: [{ code: 'ADAPTER_TIMEOUT', count: '5' }, { code: 'SEM_CODIGO', count: '1' }], byAutomation: [{ automation: 'f1', executed: '400', blocked: '12', failed: '6' }, { automation: 'f2', executed: '100', blocked: '2', failed: '0' }] },
      dimensions: [
        { key: 'bloqueadas_qtd', value: '14' }, { key: 'bloqueadas_pct', value: '2.80' }, { key: 'falhas_qtd', value: '6' }, { key: 'falhas_pct', value: '1.20' },
        { key: 'motivo:FREQUENCY_CAP:bloqueadas_qtd', value: '2' }, { key: 'motivo:NO_CONSENT:bloqueadas_qtd', value: '12' }, { key: 'erro:ADAPTER_TIMEOUT:falhas_qtd', value: '5' }, { key: 'erro:SEM_CODIGO:falhas_qtd', value: '1' },
        { key: 'automacao:f1:bloqueadas_qtd', value: '12' }, { key: 'automacao:f1:falhas_qtd', value: '6' }, { key: 'automacao:f2:bloqueadas_qtd', value: '2' }, { key: 'automacao:f2:falhas_qtd', value: '0' },
      ],
    },
  },
  {
    kind: 'period_edge', name: 'execução bloqueada sem motivo: DEGRADED e sem valor', input: { rows: [row(10, 0, { OPT_OUT: 1 }, {}, {}, { blockedWithoutReason: 2 })] },
    expected: bad('DEGRADED', 'BLOQUEIO_SEM_MOTIVO', { total: '10', blocked: '3', failed: '0', blockedWithoutReason: '2' }),
  },
  {
    kind: 'rounding', name: 'percentuais arredondam uma vez: 1 de 3 = 33,33%; 2 de 3 = 66,67%',
    input: { rows: [row(3, 2, { COOLDOWN: 1 }, { E1: 2 }, {})] },
    expected: {
      value: '3', status: 'OK', details: { total: '3', blocked: '1', failed: '2', blockedPct: '33.33', failedPct: '66.67', byReason: [{ reason: 'COOLDOWN', count: '1' }], byErrorCode: [{ code: 'E1', count: '2' }], byAutomation: [] },
      dimensions: [{ key: 'bloqueadas_qtd', value: '1' }, { key: 'bloqueadas_pct', value: '33.33' }, { key: 'falhas_qtd', value: '2' }, { key: 'falhas_pct', value: '66.67' }, { key: 'motivo:COOLDOWN:bloqueadas_qtd', value: '1' }, { key: 'erro:E1:falhas_qtd', value: '2' }],
    },
  },
  { kind: 'period_edge', name: 'campos ainda não calculados pelo read model: DEGRADED', input: { rows: [{ executed: 3, failed: 0, blockedWithoutReason: null, blockedByReason: null, failedByCode: null, byAutomation: null }] }, expected: bad('DEGRADED', 'READ_MODEL_NAO_RECALCULADO', {}) },
];

module.exports = { id: 'mkt.automations_blocked_failed', version: 1, compute, testCases };
