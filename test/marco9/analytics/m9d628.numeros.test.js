'use strict';

// M9-D628 — os números de cada read model de Tecnologia e IA contra a conta feita à mão sobre as fontes semeadas (cenário de m9d628Scenario): colunas do livro, fuso de São
// Paulo (sonda às 23:30 do dia 27), janela mais recente do health, motivos de bloqueio e custo em reais com uma só rodada de arredondamento. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env628 = require('../_helpers/m9d628Env');
const scenario = require('../_helpers/m9d628Scenario');

let env;
before(async () => {
  env = await env628.setup();
  await scenario.seedAll(env, env.tenantA);
  await env628.runSchedule(env.tenantA, env628.NOW);
});
after(() => env628.teardown(env));

const rows = (model) => env628.content(env, model, env.tenantA);

test('m9d628 disponibilidade: sondas feitas, bem-sucedidas e esperadas por dia de São Paulo', async () => {
  assert.deepEqual(await rows('rm_tech_availability'), [
    // DI-BI-1: no dia em que a série da sonda começa, as esperadas contam da primeira sonda (API desde 10:51 de hoje: 69 até 12:00); a de 20:00Z (futura) e a sonda CACHE não entram
    { probe: 'API', day: '2026-10-28', checks: '10', up: '10', expected: '69' },
    { probe: 'DATABASE', day: '2026-10-27', checks: '1', up: '1', expected: '30' }, // 02:30Z de 28/10 é 23:30 de 27/10 em São Paulo: a série começa ali, 30 minutos até a meia-noite
    { probe: 'DATABASE', day: '2026-10-28', checks: '5', up: '4', expected: '720' },
  ]);
});

test('m9d628 filas: profundidade, item mais antigo e DLQ do outbox e da inbox', async () => {
  const mine = (await rows('rm_tech_queues')).filter((r) => ['crm.x', 'finance.y', 'm9d628-consumer'].includes(r.event_type));
  assert.deepEqual(mine, [
    { queue: 'inbox', event_type: 'm9d628-consumer', depth: '2', oldest_at: '2026-10-28T13:00:00.000Z', dlq_depth: '1' },
    { queue: 'outbox', event_type: 'crm.x', depth: '3', oldest_at: '2026-10-28T11:00:00.000Z', dlq_depth: '1' },
    { queue: 'outbox', event_type: 'finance.y', depth: '0', oldest_at: null, dlq_depth: '1' },
  ]);
});

test('m9d628 freshness: limite do domínio, última fonte lida e estado', async () => {
  const mine = (await rows('rm_tech_freshness')).filter((r) => r.read_model.includes('m9d628'));
  const at = (min) => new Date(env628.NOW.getTime() - min * 60000).toISOString();
  assert.deepEqual(mine, [
    { read_model: 'rm_finance_m9d628', max_age_minutes: '60', last_snapshot_at: at(30), state: 'FRESH' },
    { read_model: 'rm_legal_m9d628', max_age_minutes: '240', last_snapshot_at: at(600), state: 'STALE' },
    { read_model: 'rm_m9d628_tec', max_age_minutes: '15', last_snapshot_at: at(5), state: 'FRESH' },
    { read_model: 'rm_rental_m9d628', max_age_minutes: '240', last_snapshot_at: at(1200), state: 'EXPIRED' },
  ]);
});

test('m9d628 integrações: os 9 valores da última janela de cada connection ativa, por fornecedor, família, ambiente e janela', async () => {
  const mine = (await rows('rm_tech_integrations')).filter((r) => ['messaging-sandbox', 'portal-sandbox'].includes(r.provider));
  const zero = { rate_limit_count: '0', auth_failures: '0', retries: '0', dlq: '0', backlog: '0' };
  const messaging = { provider: 'messaging-sandbox', family: 'MESSAGING', error_limit_pct: '0.50', connections: '1' }; // HIGH: SLO 99,5% => limite de erro 0,50
  assert.deepEqual(mine, [
    { ...messaging, environment: 'PRODUCTION', window_minutes: '60', calls: '100', errors: '2', success_rate: '98.00', latency_p95_ms: '500', latency_p99_ms: '800', ...zero, quota_remaining: '70' },
    { ...messaging, environment: 'SANDBOX', window_minutes: '5', calls: '4', errors: '1', success_rate: '75.00', latency_p95_ms: '100', latency_p99_ms: '120', ...zero, quota_remaining: null },
    { // a janela de 13:00 (999 chamadas) é antiga: vale a última de cada connection
      ...messaging, environment: 'SANDBOX', window_minutes: '60', calls: '100', errors: '10', success_rate: '90.00', latency_p95_ms: '300', latency_p99_ms: '900',
      rate_limit_count: '2', auth_failures: '1', retries: '5', dlq: '1', backlog: '3', quota_remaining: '50',
    },
    { provider: 'portal-sandbox', family: 'PORTAL', environment: 'PRODUCTION', window_minutes: '60', calls: '0', errors: '0', success_rate: null, latency_p95_ms: null, latency_p99_ms: null, ...zero, quota_remaining: null, error_limit_pct: '1.00', connections: '1' }, // MEDIUM: 99,0% => 1,00; a connection DRAFT não entra
  ]);
});

test('m9d628 eventos bloqueados: motivo, tipo e dia de São Paulo; sem motivo vira NO_REASON', async () => {
  const mine = (await rows('rm_tech_blocked_events')).filter((r) => ['marketing.automation_run', 'finance.transfer.blocked', 'integration.dispatch:publishListing'].includes(r.event_type));
  assert.deepEqual(mine, [
    { day: '2026-10-27', reason: 'CONSENT', event_type: 'marketing.automation_run', blocked: '1' },
    { day: '2026-10-28', reason: 'CONSENT', event_type: 'marketing.automation_run', blocked: '2' },
    { day: '2026-10-28', reason: 'KILL_SWITCH', event_type: 'marketing.automation_run', blocked: '1' },
    { day: '2026-10-28', reason: 'NO_REASON', event_type: 'marketing.automation_run', blocked: '1' },
    { day: '2026-10-28', reason: 'QUIET_HOURS', event_type: 'marketing.automation_run', blocked: '1' },
    { day: '2026-10-28', reason: 'SECURITY_POLICY', event_type: 'finance.transfer.blocked', blocked: '2' },
    { day: '2026-10-28', reason: 'VALIDATION', event_type: 'integration.dispatch:publishListing', blocked: '1' },
  ]);
});

test('m9d628 falhas de autenticação: login, MFA e integração, com atores distintos e o pico por hora', async () => {
  const mine = (await rows('rm_tech_auth_failures')).filter((r) => r.provider === '-' || r.provider === 'messaging-sandbox');
  assert.deepEqual(mine, [
    { day: '2026-10-28', kind: 'INTEGRATION', provider: 'messaging-sandbox', failures: '2', distinct_actors: '1', peak_hour_failures: '2' },
    { day: '2026-10-28', kind: 'LOGIN', provider: '-', failures: '3', distinct_actors: '2', peak_hour_failures: '2' },
    { day: '2026-10-28', kind: 'MFA', provider: '-', failures: '1', distinct_actors: '1', peak_hour_failures: '1' },
  ]);
});

test('m9d628 custo de IA: reais com 2 casas arredondados uma vez, orçamento ativo do mês e execução sem custo', async () => {
  // as colunas de cálculo dos KPIs (runs_without_cost, by_model) são da M9-D681 e têm teste próprio
  assert.deepEqual((await rows('rm_ai_cost')).map(({ runs_without_cost: _w, by_model: _m, ...rest }) => rest), [
    { agent: 'NAY_COMERCIAL', month: '2026-09', cost_brl: '5.00', budget_brl: null, runs: '1' },
    { agent: 'NAY_COMERCIAL', month: '2026-10', cost_brl: '3.34', budget_brl: '100.00', runs: '4' }, // 1,234567 + 2,005 + 0,1 + (regra sem custo) = 3,339567 => 3,34; o orçamento pausado fica fora
  ]);
});

test('m9d628 qualidade da IA: fundamentação e avaliação por semana (segunda-feira de São Paulo)', async () => {
  assert.deepEqual(await rows('rm_ai_quality'), [
    { agent: 'NAY_COMERCIAL', week: '2026-09-28', runs: '1', grounding_runs: '1', grounding_score_sum: '1.0000', eval_items: '0', eval_score_sum: '0.0000' },
    { agent: 'NAY_COMERCIAL', week: '2026-10-05', runs: '1', grounding_runs: '1', grounding_score_sum: '1.0000', eval_items: '0', eval_score_sum: '0.0000' },
    { agent: 'NAY_COMERCIAL', week: '2026-10-19', runs: '3', grounding_runs: '2', grounding_score_sum: '1.0000', eval_items: '3', eval_score_sum: '1.7500' },
  ]);
});

test('m9d628 chamadas de ferramenta: total e bloqueadas por agente e dia', async () => {
  assert.deepEqual((await rows('rm_ai_tool_calls')).map(({ by_tool: _t, by_reason: _r, ...rest }) => rest), [
    { agent: 'NAY_COMERCIAL', day: '2026-10-10', calls: '2', blocked: '1' },
    { agent: 'NAY_COMERCIAL', day: '2026-10-20', calls: '1', blocked: '0' },
  ]);
});
