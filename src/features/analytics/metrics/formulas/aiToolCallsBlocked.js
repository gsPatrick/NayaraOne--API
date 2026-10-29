'use strict';

/**
 * M9-D681 — KPI ai.tool_calls_blocked (Tool calls bloqueadas), versão 1. Posição no mês de São Paulo até a data-base: chamadas de ferramenta da NAY totais, BLOQUEADAS (estado BLOCKED
 * por blocked_reason: allowlist, permissão, schema, injeção, cross-company, segredo, orçamento, política e STALE, a proposta cujo snapshot ficou desatualizado) e % bloqueadas =
 * bloqueadas ÷ totais × 100 (2 casas), por agente, ferramenta e motivo. A proposta aguardando aprovação (PROPOSED) e a rejeição humana (CANCELLED_BY_HUMAN) NÃO são bloqueio:
 * contam nas chamadas e ficam fora das bloqueadas. O valor é o total de bloqueadas. Exemplo: 1.200 chamadas e 5 bloqueadas => 0,42%. Entrada (rm_ai_tool_calls do mês): { rows: [{ agent, day,
 * calls, blocked, byTool: { ferramenta: { calls, blocked } }, byReason: { motivo: n } }] }. Parâmetro: knownReasons (motivos com linha própria; os outros somam em `other`). Regra de
 * qualidade: bloqueio sem motivo (NO_REASON) -> DEGRADED e sem valor.
 */
const money = require('./money');
const { degraded, incomplete, sumCounts } = require('./_legalCorKpi');
const { safe, distinct } = require('./_aiKpi');

const NO_REASON = 'NO_REASON';
const DEFAULT_KNOWN = ['ALLOWLIST', 'PERMISSION', 'SCHEMA', 'INJECTION', 'CROSS_COMPANY', 'SECRET', 'BUDGET', 'POLICY', 'STALE'];

const pctOf = (blocked, calls) => (money.cmp(calls, 0) > 0 ? money.percent(blocked, calls).value : null);

function toolsOf(rows) {
  const out = new Map();
  for (const row of rows) {
    for (const [tool, v] of Object.entries(row.byTool || {})) {
      const prev = out.get(tool) || { calls: '0', blocked: '0' };
      out.set(tool, { calls: money.count(money.add(prev.calls, v.calls ?? 0)), blocked: money.count(money.add(prev.blocked, v.blocked ?? 0)) });
    }
  }
  return out;
}

function reasonsOf(rows) {
  const out = new Map();
  for (const row of rows) for (const [reason, n] of Object.entries(row.byReason || {})) out.set(reason, money.count(money.add(out.get(reason) || '0', n)));
  return out;
}

function lines(dimensions, group, id, blocked, calls) {
  const key = `${group}:${safe(id)}`;
  dimensions.push({ key, value: blocked }, { key: `${key}:chamadas_qtd`, value: calls });
  const pct = pctOf(blocked, calls);
  if (pct !== null) dimensions.push({ key: `${key}:bloqueadas_pct`, value: pct });
}

function compute(input, params = {}) {
  const rows = input.rows || [];
  const known = Array.isArray(params.knownReasons) && params.knownReasons.length ? params.knownReasons : DEFAULT_KNOWN;
  if (rows.some((r) => !r.byTool || !r.byReason)) return incomplete('AINDA_NAO_CALCULADO', {}); // campos novos do read model ainda nulos
  const reasons = reasonsOf(rows);
  if (money.cmp(reasons.get(NO_REASON) || 0, 0) > 0) return degraded('BLOQUEIO_SEM_MOTIVO', { withoutReason: reasons.get(NO_REASON) });
  const calls = sumCounts(rows.map((r) => r.calls));
  const blocked = sumCounts(rows.map((r) => r.blocked));
  const pct = pctOf(blocked, calls);
  const dimensions = [{ key: 'chamadas_qtd', value: calls }];
  if (pct !== null) dimensions.push({ key: 'bloqueadas_pct', value: pct });
  const byAgent = [];
  for (const agent of distinct(rows.map((r) => r.agent))) {
    const own = rows.filter((r) => r.agent === agent);
    const c = sumCounts(own.map((r) => r.calls));
    const b = sumCounts(own.map((r) => r.blocked));
    byAgent.push({ agent, calls: c, blocked: b, blockedPct: pctOf(b, c) });
    lines(dimensions, 'agente', agent, b, c);
  }
  const tools = toolsOf(rows);
  const byTool = [];
  for (const tool of distinct([...tools.keys()])) {
    const t = tools.get(tool);
    byTool.push({ tool, calls: t.calls, blocked: t.blocked, blockedPct: pctOf(t.blocked, t.calls) });
    lines(dimensions, 'ferramenta', tool, t.blocked, t.calls);
  }
  const byReason = Object.fromEntries(known.map((reason) => [reason, reasons.get(reason) || '0']));
  for (const reason of known) dimensions.push({ key: `motivo:${safe(reason)}`, value: byReason[reason] });
  const other = Object.fromEntries(distinct([...reasons.keys()].filter((r) => !known.includes(r))).map((r) => [r, reasons.get(r)]));
  dimensions.push({ key: 'outro_qtd', value: sumCounts(Object.values(other)) });
  return { value: blocked, status: 'OK', details: { calls, blocked, blockedPct: pct, byReason, other, byAgent, byTool }, dimensions };
}

const row = (agent, day, calls, blocked, byTool, byReason) => ({ agent, day, calls, blocked, byTool, byReason });

const testCases = [
  { kind: 'empty', name: 'nenhuma chamada no mês: zero bloqueadas e sem percentual', input: { rows: [] }, expected: { value: '0', status: 'OK', details: { calls: '0', blocked: '0', blockedPct: null, byReason: { ALLOWLIST: '0', PERMISSION: '0', SCHEMA: '0', INJECTION: '0', CROSS_COMPANY: '0', SECRET: '0', BUDGET: '0', POLICY: '0', STALE: '0' }, other: {  }, byAgent: [], byTool: [] }, dimensions: [{ key: 'chamadas_qtd', value: '0' }, { key: 'motivo:ALLOWLIST', value: '0' }, { key: 'motivo:PERMISSION', value: '0' }, { key: 'motivo:SCHEMA', value: '0' }, { key: 'motivo:INJECTION', value: '0' }, { key: 'motivo:CROSS_COMPANY', value: '0' }, { key: 'motivo:SECRET', value: '0' }, { key: 'motivo:BUDGET', value: '0' }, { key: 'motivo:POLICY', value: '0' }, { key: 'motivo:STALE', value: '0' }, { key: 'outro_qtd', value: '0' }] } },
  {
    kind: 'single', name: 'uma chamada bloqueada por permissão: 100,00%',
    input: { rows: [row('NAY_COMERCIAL', '2026-10-26', 1, 1, { 'crm.list': { calls: 1, blocked: 1 } }, { PERMISSION: 1 })] }, expected: { value: '1', status: 'OK', details: { calls: '1', blocked: '1', blockedPct: '100.00', byReason: { ALLOWLIST: '0', PERMISSION: '1', SCHEMA: '0', INJECTION: '0', CROSS_COMPANY: '0', SECRET: '0', BUDGET: '0', POLICY: '0', STALE: '0' }, other: {  }, byAgent: [{ agent: 'NAY_COMERCIAL', calls: '1', blocked: '1', blockedPct: '100.00' }], byTool: [{ tool: 'crm.list', calls: '1', blocked: '1', blockedPct: '100.00' }] }, dimensions: [{ key: 'chamadas_qtd', value: '1' }, { key: 'bloqueadas_pct', value: '100.00' }, { key: 'agente:NAY_COMERCIAL', value: '1' }, { key: 'agente:NAY_COMERCIAL:chamadas_qtd', value: '1' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_pct', value: '100.00' }, { key: 'ferramenta:crm.list', value: '1' }, { key: 'ferramenta:crm.list:chamadas_qtd', value: '1' }, { key: 'ferramenta:crm.list:bloqueadas_pct', value: '100.00' }, { key: 'motivo:ALLOWLIST', value: '0' }, { key: 'motivo:PERMISSION', value: '1' }, { key: 'motivo:SCHEMA', value: '0' }, { key: 'motivo:INJECTION', value: '0' }, { key: 'motivo:CROSS_COMPANY', value: '0' }, { key: 'motivo:SECRET', value: '0' }, { key: 'motivo:BUDGET', value: '0' }, { key: 'motivo:POLICY', value: '0' }, { key: 'motivo:STALE', value: '0' }, { key: 'outro_qtd', value: '0' }] },
  },
  {
    kind: 'typical', name: 'exemplo do livro: 1.200 chamadas e 5 bloqueadas => 0,42%; STALE conta como bloqueio',
    input: { rows: [row('NAY_COMERCIAL', '2026-10-26', 1200, 5, { 'crm.list': { calls: 1000, blocked: 3 }, 'finance.get': { calls: 200, blocked: 2 } }, { PERMISSION: 3, STALE: 2 })] }, expected: { value: '5', status: 'OK', details: { calls: '1200', blocked: '5', blockedPct: '0.42', byReason: { ALLOWLIST: '0', PERMISSION: '3', SCHEMA: '0', INJECTION: '0', CROSS_COMPANY: '0', SECRET: '0', BUDGET: '0', POLICY: '0', STALE: '2' }, other: {  }, byAgent: [{ agent: 'NAY_COMERCIAL', calls: '1200', blocked: '5', blockedPct: '0.42' }], byTool: [{ tool: 'crm.list', calls: '1000', blocked: '3', blockedPct: '0.30' }, { tool: 'finance.get', calls: '200', blocked: '2', blockedPct: '1.00' }] }, dimensions: [{ key: 'chamadas_qtd', value: '1200' }, { key: 'bloqueadas_pct', value: '0.42' }, { key: 'agente:NAY_COMERCIAL', value: '5' }, { key: 'agente:NAY_COMERCIAL:chamadas_qtd', value: '1200' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_pct', value: '0.42' }, { key: 'ferramenta:crm.list', value: '3' }, { key: 'ferramenta:crm.list:chamadas_qtd', value: '1000' }, { key: 'ferramenta:crm.list:bloqueadas_pct', value: '0.30' }, { key: 'ferramenta:finance.get', value: '2' }, { key: 'ferramenta:finance.get:chamadas_qtd', value: '200' }, { key: 'ferramenta:finance.get:bloqueadas_pct', value: '1.00' }, { key: 'motivo:ALLOWLIST', value: '0' }, { key: 'motivo:PERMISSION', value: '3' }, { key: 'motivo:SCHEMA', value: '0' }, { key: 'motivo:INJECTION', value: '0' }, { key: 'motivo:CROSS_COMPANY', value: '0' }, { key: 'motivo:SECRET', value: '0' }, { key: 'motivo:BUDGET', value: '0' }, { key: 'motivo:POLICY', value: '0' }, { key: 'motivo:STALE', value: '2' }, { key: 'outro_qtd', value: '0' }] },
  },
  {
    kind: 'period_edge', name: 'bloqueio sem motivo (NO_REASON): DEGRADED e sem valor, nenhum número enganoso',
    input: { rows: [row('NAY_COMERCIAL', '2026-10-26', 10, 2, { 'crm.list': { calls: 10, blocked: 2 } }, { NO_REASON: 1, PERMISSION: 1 })] }, expected: { value: null, status: 'DEGRADED', message: 'Dado incompleto, valor não confiável.', details: { reason: 'BLOQUEIO_SEM_MOTIVO', withoutReason: '1' }, dimensions: [] },
  },
  {
    kind: 'period_edge', name: 'read model ainda não recalculado (campos novos nulos): INCOMPLETE e sem valor, nunca zero',
    input: { rows: [{ agent: 'NAY_COMERCIAL', day: '2026-10-26', calls: 10, blocked: 2, byTool: null, byReason: null }] },
    expected: { value: null, status: 'INCOMPLETE', message: 'Dado incompleto, valor não confiável.', details: { reason: 'AINDA_NAO_CALCULADO' }, dimensions: [] },
  },
  {
    kind: 'rounding', name: 'percentual arredondado uma vez (meio para cima) e dois dias somados; motivo fora da lista conhecida soma em other',
    input: { rows: [row('NAY_COMERCIAL', '2026-10-26', 7, 1, { 'crm.list': { calls: 7, blocked: 1 } }, { TOOL_LIMIT: 1 }), row('NAY_COMERCIAL', '2026-10-27', 5, 1, { 'crm.list': { calls: 5, blocked: 1 } }, { BUDGET: 1 })] }, expected: { value: '2', status: 'OK', details: { calls: '12', blocked: '2', blockedPct: '16.67', byReason: { ALLOWLIST: '0', PERMISSION: '0', SCHEMA: '0', INJECTION: '0', CROSS_COMPANY: '0', SECRET: '0', BUDGET: '1', POLICY: '0', STALE: '0' }, other: { TOOL_LIMIT: '1' }, byAgent: [{ agent: 'NAY_COMERCIAL', calls: '12', blocked: '2', blockedPct: '16.67' }], byTool: [{ tool: 'crm.list', calls: '12', blocked: '2', blockedPct: '16.67' }] }, dimensions: [{ key: 'chamadas_qtd', value: '12' }, { key: 'bloqueadas_pct', value: '16.67' }, { key: 'agente:NAY_COMERCIAL', value: '2' }, { key: 'agente:NAY_COMERCIAL:chamadas_qtd', value: '12' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_pct', value: '16.67' }, { key: 'ferramenta:crm.list', value: '2' }, { key: 'ferramenta:crm.list:chamadas_qtd', value: '12' }, { key: 'ferramenta:crm.list:bloqueadas_pct', value: '16.67' }, { key: 'motivo:ALLOWLIST', value: '0' }, { key: 'motivo:PERMISSION', value: '0' }, { key: 'motivo:SCHEMA', value: '0' }, { key: 'motivo:INJECTION', value: '0' }, { key: 'motivo:CROSS_COMPANY', value: '0' }, { key: 'motivo:SECRET', value: '0' }, { key: 'motivo:BUDGET', value: '1' }, { key: 'motivo:POLICY', value: '0' }, { key: 'motivo:STALE', value: '0' }, { key: 'outro_qtd', value: '1' }] },
  },
  {
    kind: 'rounding', name: 'os motivos conhecidos são parâmetro: o que sai da lista soma em other',
    input: { rows: [row('NAY_COMERCIAL', '2026-10-26', 4, 2, { 'a.b': { calls: 4, blocked: 2 } }, { PERMISSION: 1, STALE: 1 })] }, params: { knownReasons: ['STALE'] }, expected: { value: '2', status: 'OK', details: { calls: '4', blocked: '2', blockedPct: '50.00', byReason: { STALE: '1' }, other: { PERMISSION: '1' }, byAgent: [{ agent: 'NAY_COMERCIAL', calls: '4', blocked: '2', blockedPct: '50.00' }], byTool: [{ tool: 'a.b', calls: '4', blocked: '2', blockedPct: '50.00' }] }, dimensions: [{ key: 'chamadas_qtd', value: '4' }, { key: 'bloqueadas_pct', value: '50.00' }, { key: 'agente:NAY_COMERCIAL', value: '2' }, { key: 'agente:NAY_COMERCIAL:chamadas_qtd', value: '4' }, { key: 'agente:NAY_COMERCIAL:bloqueadas_pct', value: '50.00' }, { key: 'ferramenta:a.b', value: '2' }, { key: 'ferramenta:a.b:chamadas_qtd', value: '4' }, { key: 'ferramenta:a.b:bloqueadas_pct', value: '50.00' }, { key: 'motivo:STALE', value: '1' }, { key: 'outro_qtd', value: '1' }] },
  },
];

module.exports = { id: 'ai.tool_calls_blocked', version: 1, compute, testCases };
