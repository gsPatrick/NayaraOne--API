'use strict';

// Apoio dos testes M9-D830 e M9-D831 (não é teste). Rodar SEMPRE em banco descartável (scripts/withDisposableDb.js). Operações, evidências e parâmetros são gravados de verdade (commit).
const env = require('./dlpEnv');
const { withRolePermissions } = require('./exportsEnv');
const { withOwnTenantTransaction } = require('../../../src/features/core-governance/dlp/guard.tx');
const { uploadFile } = require('../../../src/features/files/files.service');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const tenantOf = (t) => ({ groupId: t.groupId, companyId: t.companyId });
const inTx = (tenant, fn, userId) => withOwnTenantTransaction(tenant, userId || tenant.userId, fn);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const used = new Set();
const next = () => { let n; do { n = 1 + Math.floor(Math.random() * 99999); } while (used.has(n)); used.add(n); return String(n).padStart(5, '0'); };

/** Número de formulário válido e novo (sequencial de 5 dígitos sorteado sem repetir). */
const reference = (prefix = 'FIN', year = 2026) => `${prefix}-${year}-${next()}`;

/** Foto do papel gravada de verdade em people.files; devolve o id. */
async function evidence(tenant) {
  const file = await inTx(tenant, (transaction) => uploadFile({
    groupId: tenant.groupId, companyId: tenant.companyId, fileName: `papel-${next()}.png`, mimeType: 'image/png', contentBase64: PNG, category: 'generic',
  }, tenant.userId, transaction));
  return file.id;
}

/** Define o parâmetro governanca.bcp.setor_por_papel da empresa. */
const setSectorRoles = (tenant, map) => inTx(tenant, (tx) => upsertSetting('governanca.bcp.setor_por_papel', JSON.stringify(map), tenantOf(tenant), tenant.userId, tx));

const RECEBIMENTO = { pagador: 'Maria QA-M9', documento: '12345678909', valorCentavos: 125000, forma: 'PIX', data: '2026-10-20', referenciaParcela: 'PARC-1', comprovanteAnexado: 'SIM' };
const DIARIO = { obra: 'OBRA-1', data: '2026-10-20', equipePresente: '5 pessoas', servicosExecutados: 'Alvenaria', fotosQuantidade: 3 };

/** Corpo válido de POST /bcp/manual-operations para o setor FINANCEIRO (ou OBRAS). */
function body(tenant, over = {}) {
  return { sector: 'FINANCEIRO', manualReference: reference('FIN'), occurredAt: '2026-10-20T09:30', evidenceFileId: over.evidenceFileId, intendedAction: 'RECEIVE_PAYMENT', formType: 'RECEBIMENTO', payload: { ...RECEBIMENTO }, ...over };
}

/** Registra como a rota faz (transação da requisição). `fileId` opcional: sem ele, grava uma foto nova. */
async function record(tenant, over = {}, actorUserId) {
  const evidenceFileId = over.evidenceFileId === undefined ? await evidence(tenant) : over.evidenceFileId;
  const actor = actorUserId || tenant.userId;
  const service = require('../../../src/features/core-governance/bcp/manualOperation.service'); // só existe a partir da M9-D831
  return inTx(tenant, (transaction) => service.recordOperation({ tenant: tenantOf(tenant), actorUserId: actor, body: body(tenant, { ...over, evidenceFileId }), transaction }), actor);
}

const failure = (promise) => promise.then(() => null, (err) => ({ status: err.statusCode, code: err.code, message: err.message, details: err.details }));
const opRow = async (id) => (await env.adminQuery('SELECT * FROM governance.manual_operations WHERE id = $1', [id])).rows[0] || null;
const outbox = async (key) => (await env.adminQuery('SELECT * FROM integration.outbox_events WHERE idempotency_key = $1', [key])).rows;
/** Auditorias de uma ação da empresa (leitura do superusuário do cluster descartável; a RLS do audit_log não se aplica a ele). */
const auditOf = async (tenant, action) => (await env.adminQuery('SELECT * FROM audit.audit_log WHERE company_id = $1 AND action = $2 ORDER BY occurred_at DESC', [tenant.companyId, action])).rows;
const otherUserId = async () => (await env.adminQuery("SELECT id FROM core.users WHERE email = 'ci-a-maker@ci.nayaraone.test'")).rows[0].id;

/** Remove operações e parâmetros de teste (a auditoria e as evidências são só de acréscimo e ficam). */
async function cleanBcp() {
  await env.adminQuery('DELETE FROM governance.manual_operations');
  await env.adminQuery("DELETE FROM core.tenant_settings WHERE key LIKE 'governanca.bcp.%'");
}

module.exports = { ...env, withRolePermissions, tenantOf, inTx, reference, evidence, setSectorRoles, body, record, failure, opRow, outbox, auditOf, otherUserId, cleanBcp, RECEBIMENTO, DIARIO };
