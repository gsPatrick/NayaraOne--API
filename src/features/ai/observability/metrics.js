'use strict';

/**
 * Métricas da NAY (M9-D047, item 15 do Definition of Done), no formato Prometheus, sobre o registro único de src/utils/metrics.js
 * (exposto em /api/metrics). Os rótulos são sempre valores de um conjunto pequeno (agente, estado, caminho, ferramenta, motivo, origem,
 * provedor): nunca texto de pedido, resposta, documento nem identificador de pessoa. Registrar uma métrica nunca derruba a operação.
 */
const client = require('prom-client');
const { register } = require('../../../utils/metrics');

const DEFAULT_BUCKETS_MS = '50,100,250,500,1000,2500,5000,10000,30000,60000';
const LABEL_MAX = 80;

/** Limites do histograma de latência (ms), da variável AI_LATENCY_BUCKETS_MS; valor inválido volta ao padrão. */
function latencyBuckets(raw = process.env.AI_LATENCY_BUCKETS_MS) {
  const parse = (text) => String(text).split(',').map((x) => Number(x.trim()));
  let list = parse(raw || DEFAULT_BUCKETS_MS);
  if (!list.length || list.some((n) => !Number.isFinite(n) || n <= 0) || list.some((n, i) => i > 0 && n <= list[i - 1])) list = parse(DEFAULT_BUCKETS_MS);
  return list;
}

/** Chaves já contadas (o evento de injeção é idempotente por run e fonte: republicar não pode contar de novo). Limitado para não crescer sem fim. */
const SEEN_MAX = 10000;
const seen = new Set();
function firstTime(key) {
  if (seen.has(key)) return false;
  if (seen.size >= SEEN_MAX) seen.delete(seen.values().next().value);
  seen.add(key);
  return true;
}

const label = (value) => String(value === undefined || value === null || value === '' ? 'UNKNOWN' : value).slice(0, LABEL_MAX);

function metric(Type, name, help, labelNames = [], extra = {}) {
  return register.getSingleMetric(name) || new Type({ name, help, labelNames, registers: [register], ...extra });
}

const runs = metric(client.Counter, 'ai_runs_total', 'Execuções da NAY por agente, estado e caminho de roteamento', ['agent', 'status', 'path']);
const latency = metric(client.Histogram, 'ai_run_latency_ms', 'Latência das execuções da NAY em milissegundos (p50, p95 e p99 pelos limites)', ['agent'], { buckets: latencyBuckets() });
const cost = metric(client.Counter, 'ai_cost_brl_total', 'Custo das execuções da NAY em reais', ['agent', 'provider']);
const toolCalls = metric(client.Counter, 'ai_tool_calls_total', 'Chamadas de ferramenta da NAY por ferramenta e estado', ['tool', 'status']);
const blocked = metric(client.Counter, 'ai_blocked_total', 'Execuções da NAY encerradas por bloqueio de segurança, por motivo', ['reason']);
const insufficient = metric(client.Counter, 'ai_insufficient_sources_total', 'Respostas da NAY que disseram que as fontes não bastam');
const injections = metric(client.Counter, 'ai_injection_detected_total', 'Tentativas de injeção de instrução detectadas, por origem do texto', ['origin']);
const fallbacks = metric(client.Counter, 'ai_fallback_total', 'Trocas de modelo por falha do provedor (fallback seguro)', ['from', 'to']);
const budgetPct = metric(client.Gauge, 'ai_budget_pct', 'Percentual consumido de cada orçamento de IA na última leitura', ['budget']);
const circuitOpen = metric(client.Gauge, 'ai_provider_circuit_open', '1 quando o circuito do provedor de modelo está aberto, 0 quando fechado', ['provider']);

/** Quando o run terminou: a duração gravada (ms) ou, sem ela, a diferença entre início e fim. */
function durationOf(run) {
  if (Number.isFinite(Number(run.latencyMs)) && run.latencyMs !== null) return Number(run.latencyMs);
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.finishedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

const recorders = {
  /** run: o que toRun devolve (agentCode, status, routingPath, providerCode, costAmount, latencyMs, groundingStatus, blockedReason). */
  runFinished(run) {
    const agent = label(run.agentCode);
    runs.inc({ agent, status: label(run.status), path: label(run.routingPath) });
    const ms = durationOf(run);
    if (ms !== null && run.status !== 'AWAITING_APPROVAL') latency.observe({ agent }, ms);
    const brl = Number(run.costAmount);
    if (Number.isFinite(brl) && brl > 0) cost.inc({ agent, provider: label(run.providerCode) }, brl);
    if (run.status === 'BLOCKED') blocked.inc({ reason: label(run.blockedReason) });
    if (run.groundingStatus === 'INSUFFICIENT_SOURCES') insufficient.inc();
  },
  toolCall: (tool, status) => toolCalls.inc({ tool: label(tool), status: label(status) }),
  /** `key` = run e fonte da detecção: o mesmo par conta uma vez só, como o evento do outbox. */
  injectionDetected: (origin, key) => { if (key === undefined || firstTime(`injection:${key}`)) injections.inc({ origin: label(origin) }); },
  fallback: (from, to) => fallbacks.inc({ from: label(from), to: label(to) }),
  budgetPct: (budget, pct) => { if (Number.isFinite(Number(pct))) budgetPct.set({ budget: label(budget) }, Number(pct)); },
  circuitOpen: (provider, open) => circuitOpen.set({ provider: label(provider) }, open ? 1 : 0),
};

/** As mesmas funções, sem nunca lançar: métrica é observação, não pode quebrar o run. */
const safe = Object.fromEntries(Object.entries(recorders).map(([name, fn]) => [name, (...args) => { try { fn(...args); } catch (err) { /* observação nunca derruba a operação */ } }]));

const METRIC_NAMES = Object.freeze(['ai_runs_total', 'ai_run_latency_ms', 'ai_cost_brl_total', 'ai_tool_calls_total', 'ai_blocked_total', 'ai_insufficient_sources_total',
  'ai_injection_detected_total', 'ai_fallback_total', 'ai_budget_pct', 'ai_provider_circuit_open']);

module.exports = { metrics: safe, latency, latencyBuckets, METRIC_NAMES };
