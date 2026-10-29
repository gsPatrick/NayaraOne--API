'use strict';

// Apoio dos testes da M9-D709 (fila de decisão do Centro de Comando): duas empresas NOVAS no grupo do seed (valores independentes do que outros testes gravaram),
// as quatro filas de origem gravadas por superusuário (sem FK, só o que o teste precisa), eventos do outbox simulados, cálculo dos KPIs e leitura pela rota real.
// Banco descartável (127.0.0.1). Tudo o que o teste grava é apagado em `teardown`, por empresa.
const bi = require('./biObrasJuridicoEnv');
const { startServer } = require('./m9d702Env');
const kpis = require('../../../src/features/analytics/metrics/kpis');

const { uuid } = bi;
const KPI_CODES = ['fin.approvals_pending', 'inv.adjustments_pending', 'tec.rule_approvals_pending', 'ai.proposals_pending'];
const PERMS = ['analytics:read', 'analytics:drilldown', 'finance:read', 'inventory:read', 'analytics:read:tech'];
const hoursAgo = (h) => new Date(bi.NOW.getTime() - h * 3600000).toISOString();
const SOURCES = [
  'finance.approval_requests', 'finance.financial_entries', 'inventory.adjustment_proposals', 'inventory.inventory_items', 'core.rule_approval_requests', 'core.rule_versions', 'ai.ai_recommendations',
];

async function newCompany(env, label) {
  const id = uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 D709 ${label} ${id.slice(0, 6)}` } });
  return { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId };
}

async function setup() {
  const env = await bi.setup(['rm_decision_queue']);
  env.cX = await newCompany(env, 'X');
  env.cY = await newCompany(env, 'Y');
  env.server = await startServer(env, { X: env.cX, Y: env.cY });
  return env;
}

async function teardown(env) {
  await env.server.close();
  const ids = [env.cX.companyId, env.cY.companyId];
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const table of SOURCES) await env.admin.query(`DELETE FROM ${table} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_snapshots WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    for (const t of ['rm_decision_queue', 'rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks', 'access_log']) {
      await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction }).catch(() => {});
    }
    await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
  });
  bi.clock.resetClock();
  await bi.teardown({ ...env, created: [], models: [], tenantA: env.tenantA, tenantB: env.tenantB });
}

const seed = (env, t, table, cols) => bi.seed(env, t, table, cols);

/** Aprovação financeira de um lançamento de `amount` (null = aprovação de conta bancária, sem valor). Devolve o id do pedido. */
async function finApproval(env, t, { amount = null, status = 'PENDING', hours = 5, risk = 'MEDIUM', by = null } = {}) {
  let type = 'BankAccount';
  let related = uuid();
  if (amount !== null) {
    type = 'FinancialEntry';
    related = await seed(env, t, 'finance.financial_entries', { entry_type: 'DEBIT', nature: 'PAYABLE', amount, status: 'PENDING' });
  }
  const at = hoursAgo(hours);
  return seed(env, t, 'finance.approval_requests', {
    related_entity_type: type, related_entity_id: related, requested_by_user_id: by || t.userId, status, risk_level: risk, created_at: at, updated_at: status === 'PENDING' ? at : bi.NOW.toISOString(),
  });
}

/** Proposta de ajuste: `quantity` unidades de um item de custo médio `cost` (null = sem custo; usa o valor estimado). */
async function invProposal(env, t, { quantity = '1', cost = '10', estimated = null, status = 'PENDING', hours = 5, item = true, location = null } = {}) {
  const itemId = item ? await seed(env, t, 'inventory.inventory_items', { name: `Item ${uuid().slice(0, 6)}`, average_cost: cost }) : uuid();
  const at = hoursAgo(hours);
  return seed(env, t, 'inventory.adjustment_proposals', {
    inventory_item_id: itemId, movement_type: 'ADJUSTMENT', quantity, reason: 'Contagem física', idempotency_key: uuid(), proposed_by_user_id: t.userId, source_location_id: location, estimated_value: estimated,
    status, created_at: at, updated_at: at, decided_at: status === 'PENDING' ? null : bi.NOW.toISOString(),
  });
}

async function ruleApproval(env, t, { status = 'PENDING', hours = 5, rule = true } = {}) {
  const ruleId = uuid();
  const version = rule ? await seed(env, t, 'core.rule_versions', {
    rule_id: ruleId, version_number: 1, condition_ast_json: '{}', content_hash: uuid().replace(/-/g, ''), action_json: '{}', effective_from: hoursAgo(100),
  }) : uuid(); // sem versão de regra existente, o pedido fica sem regra vinculada
  const at = hoursAgo(hours);
  const id = await seed(env, t, 'core.rule_approval_requests', { rule_version_id: version, requested_by_user_id: t.userId, status, created_at: at, updated_at: status === 'PENDING' ? at : bi.NOW.toISOString() });
  return { id, ruleId: rule ? ruleId : null };
}

/** Recomendação da NAY: `proposed` = com ação proposta (entra na fila) ou informativa (não entra); `sources` e `run` controlam a regra de qualidade. */
async function nayRecommendation(env, t, { proposed = true, status = 'PENDING', hours = 5, agent = 'NAY_FINANCEIRA', run = true, sources = true } = {}) {
  const action = proposed ? JSON.stringify({ tool: 'x', snapshot: { refs: sources ? [{ entity: 'FinancialEntry', id: uuid() }] : [] } }) : null;
  const at = hoursAgo(hours);
  return seed(env, t, 'ai.ai_recommendations', {
    related_entity_type: 'FinancialEntry', related_entity_id: uuid(), recommendation_type: 'payment', agent_code: agent, ai_run_id: run ? uuid() : null, proposed_action: action,
    status, created_at: at, updated_at: at, decided_at: status === 'PENDING' ? null : bi.NOW.toISOString(),
  });
}

const EVENT_OF = { FIN_APPROVAL: 'finance.approval_request.created', INV_ADJUSTMENT: 'inventory.adjustment_proposal.created', RULE_APPROVAL: 'rules.approval_request.created', NAY_PROPOSAL: 'ai.recommendation.created' };
const eventFor = (t, kind, id, type = EVENT_OF[kind]) => bi.makeEvent(t, type, kind === 'NAY_PROPOSAL' ? { recommendationId: id } : { id });
const applyKind = (t, kind, id, type) => bi.apply(t, eventFor(t, kind, id, type));

/** Calcula e grava os snapshots dos quatro KPIs da empresa na data-base fixa. */
const materialize = (t, asOf = bi.AS_OF) => bi.inTx(t, { commit: true }, (tx) => kpis.decisionQueueKpis.materialize({ companyId: t.companyId, groupId: t.groupId }, asOf, tx));
const queueRows = async (env, t, extra = '') => (await env.admin.query(`SELECT * FROM analytics.rm_decision_queue WHERE company_id = :c ${extra} ORDER BY kind, source_id`, { replacements: { c: t.companyId } }))[0];
const get = (env, code, { tenant = 'X', perms = PERMS, query = `asOf=${bi.AS_OF}` } = {}) => env.server.call('GET', `/analytics/metrics/${code}?${query}`, { perms, tenant });

module.exports = {
  KPI_CODES, PERMS, bi, uuid, hoursAgo, setup, teardown, seed, finApproval, invProposal, ruleApproval, nayRecommendation, eventFor, applyKind, materialize, queueRows, get, EVENT_OF,
};
