'use strict';

// Apoio dos testes da M9-D695 (ferramentas da NAY Diretoria): métricas publicadas com número gravado, registro fechado, agente com a
// allowlist do livro e chamada pelo pipeline de segurança. Banco descartável (127.0.0.1). Tudo roda em transação com rollback.
const sup = require('../../analytics.m9d603.support');
const { sequelize } = require('../../testHelpers');
const registry = require('../../../src/features/analytics/metrics');
const { buildUserContext } = require('../../../src/features/ai/orchestrator/executionContext');
const { buildNayDiretoriaRegistry, nayDiretoriaAllowlist, runNayDiretoriaToolCall, NAY_DIRETORIA_AGENT_CODE } = require('../../../src/features/ai/tools');

const LIMITES = Object.freeze({ stringMax: 500, arrayMax: 50 });

async function setup() {
  const base = await sup.setup();
  const catalog = registry.createFormulaCatalog(base.formulaDir);
  const nayRegistry = await buildNayDiretoriaRegistry();
  return { ...base, catalog, nayRegistry };
}

const teardown = (env) => sup.teardown(env);

/** Publica um indicador financeiro da empresa e grava o número de cada data (e de cada dimensão, se informada). */
async function metricWithSnapshots(env, tenant, tx, { dimensions = ['company'], snapshots = [], sourceRefs = [], valueNature = 'ACTUAL', metricCode } = {}) {
  const { definition, version } = await registry.publishMetric(sup.metricInput(env, { dimensions, valueNature, ...(metricCode ? { metricCode } : {}) }), sup.ctxOf(tenant), tx, { catalog: env.catalog });
  await sup.metrics.enableAnalyticsWriter(tx);
  for (const s of snapshots) {
    await sup.metrics.recordSnapshot({
      groupId: tenant.groupId, companyId: tenant.companyId, metricId: definition.id, metricVersionId: version.id, scopeType: 'COMPANY', scopeId: tenant.companyId,
      dimensionKey: s.dimensionKey || '', periodStart: s.periodStart, periodEnd: s.periodEnd, asOfDate: s.asOfDate, valueNumeric: s.value, status: s.status || 'OK',
      sourceSnapshotAt: s.sourceSnapshotAt || null, sourceRefs: s.sourceRefs || sourceRefs,
      calcHash: registry.calcHash({ metricCode: definition.metric_code, version: 1, inputs: [{ v: s.value, k: s.dimensionKey || '' }], params: {} }),
    }, tx);
  }
  return { definition, version };
}

const agent = () => ({ id: 'ag-dir', code: NAY_DIRETORIA_AGENT_CODE, version: 1, tools: nayDiretoriaAllowlist() });
const execCtx = (tenant, permissions) => buildUserContext({ userId: tenant.userId, groupId: tenant.groupId, companyId: tenant.companyId, roles: ['DIRETORIA'], permissions }, { correlationId: 'corr-m9d695', runId: 'run-m9d695' });

function recorder() {
  const rows = [];
  return { rows, record: async (r) => { rows.push(r); }, emit: async () => {} };
}

/** Chamada de ferramenta como o orquestrador faz: pelo pipeline de segurança, com o registro fechado da NAY Diretoria. */
function callTool(env, tenant, tx, permissions, toolName, args, extra = {}) {
  return runNayDiretoriaToolCall({ execCtx: execCtx(tenant, permissions), agent: agent(), registry: env.nayRegistry, toolName, args, transaction: tx, recorder: recorder(), argsLimits: LIMITES, ...extra });
}

/** Troca o tenant da MESMA transação (GUCs de grupo e empresa): é como a empresa B enxerga o que a A gravou sem commit (RLS). */
async function asTenant(tx, tenant) {
  await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)", {
    replacements: { g: tenant.groupId, c: tenant.companyId, u: tenant.userId }, transaction: tx,
  });
}

const FINANCE_USER = ['analytics:read', 'finance:read'];

module.exports = { asTenant, setup, teardown, metricWithSnapshots, agent, execCtx, recorder, callTool, FINANCE_USER, LIMITES, inTx: sup.inTx, sup, registry, sequelize };
