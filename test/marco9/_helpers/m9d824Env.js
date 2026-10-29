'use strict';

// Apoio dos testes M9-D824 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js).
const { randomUUID } = require('node:crypto');
const env = require('./dlpEnv');
const { withTenantTransaction } = require('../../testHelpers');
const anomalyWiring = require('../../../src/features/core-governance/dlp/anomaly.wiring');
const resolver = require('../../../src/features/core-governance/dlp/classification.resolver');
const suspension = require('../../../src/features/core-governance/dlp/suspension.reader');
const sink = require('../../../src/features/core-governance/dlp/signals.sink');
const guardService = require('../../../src/features/core-governance/dlp/guard.service');

const ADMIN = 'governance:dlp:admin';
const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);

/** Liga os encaixes reais (suspensão e sinais) e fixa a classe de cada recurso: map { id: classe } (o resto é LOW). */
function setup(map = {}) {
  resolver.resetResolver(); suspension.resetReader(); sink.resetSignalSink();
  anomalyWiring.install();
  resolver.setResolver(async (_t, resources) => resources.map((r) => map[r.id] || map.default || 'LOW'));
}
const teardown = () => { resolver.resetResolver(); suspension.resetReader(); sink.resetSignalSink(); };

/** Decisão leve de VIEW/COPY com `n` recursos de uma classe (um sinal com count = n). */
const touch = (tenant, userId, action, n, resourceId = 'recurso') => guardService.decide(tenant, {
  actorUserId: userId, action, resourceType: 'people.person', resourceIds: Array.from({ length: n }, () => resourceId), permissions: [],
});
/** Pedido de exportação válido (justificativa e MFA presentes); `over` muda o que o teste precisa. */
const exportOf = (tenant, userId, over = {}) => guardService.decide(tenant, {
  actorUserId: userId, action: 'EXPORT', kind: 'EXPORT', resourceType: 'finance.entries', resourceIds: [over.resource || 'recurso'], purpose: 'CONTABIL',
  justification: 'Fechamento contábil do trimestre, pedido pelo contador.', estimatedRows: 10, mfaOk: true, permissions: ['governance:dlp:export'], ...over,
});

/** Insere sinais antigos direto (superusuário): [{ kind, classification, count, minutesAgo }]. */
async function seedSignals(tenant, userId, rows) {
  for (const row of rows) {
    await env.adminQuery(
      `INSERT INTO governance.access_signals (group_id, company_id, user_id, kind, action, classification, outcome, resource_type, count, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,'ALLOWED','people.person',$7,$8)`,
      [tenant.groupId, tenant.companyId, userId, row.kind, row.kind === 'EXPORT' ? 'EXPORT' : (row.kind === 'COPY' ? 'COPY' : 'VIEW'), row.classification || 'HIGH', row.count || 1, minutesAgo(row.minutesAgo || 0)]
    );
  }
}

const anomaliesOf = async (tenant, status) => (await env.adminQuery(
  `SELECT * FROM governance.access_anomalies WHERE company_id = $1 ${status ? "AND status = '" + status + "'" : ''} ORDER BY detected_at`, [tenant.companyId]
)).rows;
const stateOf = async (tenant, userId) => (await env.adminQuery('SELECT * FROM governance.user_dlp_state WHERE company_id = $1 AND user_id = $2', [tenant.companyId, userId])).rows[0] || null;
/** Auditorias de uma ação da empresa (superusuário: a sessão comum não tem o contexto da empresa). */
const auditOf = async (tenant, action) => (await env.adminQuery('SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = $2 ORDER BY occurred_at', [tenant.companyId, action])).rows;
const signalsOf = async (tenant, userId) => (await env.adminQuery('SELECT * FROM governance.access_signals WHERE company_id = $1 AND user_id = $2 ORDER BY occurred_at', [tenant.companyId, userId])).rows;

async function clean() {
  await env.adminQuery('DELETE FROM governance.access_anomalies');
  await env.adminQuery('DELETE FROM governance.user_dlp_state');
  await env.adminQuery('DELETE FROM governance.access_signals');
  await env.adminQuery("DELETE FROM core.notifications WHERE title = 'Acesso em massa detectado'");
  await env.adminQuery("DELETE FROM core.mfa_step_ups WHERE user_id IN (SELECT id FROM core.users WHERE email LIKE 'ci-%@ci.nayaraone.test')");
  await env.adminQuery("DELETE FROM core.tenant_settings WHERE key LIKE 'governanca.dlp.anomalia.%'");
  await env.cleanJobs();
}

module.exports = { ...env, randomUUID, withTenantTransaction, ADMIN, setup, teardown, touch, exportOf, seedSignals, anomaliesOf, auditOf, stateOf, signalsOf, clean, minutesAgo };
