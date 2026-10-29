'use strict';

// Apoio dos testes da M9-D625 (consolidado do grupo): servidor HTTP com o router real de /analytics, três empresas NOVAS no grupo do seed (X e Y com
// vínculo do usuário e papel de leitura do BI e do Financeiro; Z sem vínculo), indicadores de teste publicados por empresa (receita, custo e taxa) com
// snapshots escolhidos, e transferências entre empresas gravadas como o Financeiro grava (lançamento de saída na origem, de entrada no destino e a
// transferência). Banco descartável (127.0.0.1). Tudo o que o teste grava é apagado em `teardown`.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('./analyticsHttpEnv');
const ledger = require('./m9d615Ledger');
const registry = require('../../../src/features/analytics/metrics');
const store = require('../../../src/features/analytics/metricStore.service');
const readModels = require('../../../src/features/analytics/read-models');
const { registerConsolidationRule } = require('../../../src/features/analytics/metrics/consolidation/rules');

const AS_OF = '2026-10-28';
const NOW = new Date('2026-10-28T15:00:00Z');
const GROUP_PERMS = ['analytics:read', 'analytics:read:group'];
const CODES = { revenue: 'fin.m9d625_receita', cost: 'fin.m9d625_custo', rate: 'fin.m9d625_taxa' };
const UNITS = { [CODES.revenue]: 'BRL', [CODES.cost]: 'BRL', [CODES.rate]: 'PERCENT' };
const FIN_TABLES = ['intercompany_transfers', 'financial_entries', 'bank_accounts', 'reconciliations', 'bank_transactions', 'bank_statement_imports'];

async function newCompany(env, label, { member = true, permissions = ['analytics:read', 'finance:read'] } = {}) {
  const id = ledger.uuid();
  await env.admin.query('INSERT INTO core.companies (id, group_id, name) VALUES (:id, :g, :n)', { replacements: { id, g: env.tenantA.groupId, n: `M9 D625 ${label} ${id.slice(0, 6)}` } });
  const company = { groupId: env.tenantA.groupId, companyId: id, userId: env.tenantA.userId, name: label };
  if (member) {
    const roleId = ledger.uuid();
    await env.admin.query('INSERT INTO core.roles (id, group_id, company_id, name, is_system) VALUES (:r, :g, :c, :n, false)', { replacements: { r: roleId, g: company.groupId, c: id, n: `Leitor BI ${id.slice(0, 6)}` } });
    await env.admin.query('INSERT INTO core.role_permissions (id, role_id, permission_id) SELECT gen_random_uuid(), :r, id FROM core.permissions WHERE code IN (:codes)', { replacements: { r: roleId, codes: permissions } });
    await env.admin.query("INSERT INTO core.user_memberships (id, group_id, company_id, user_id, role_id, status) VALUES (gen_random_uuid(), :g, :c, :u, :r, 'ACTIVE')", { replacements: { g: company.groupId, c: id, u: company.userId, r: roleId } });
  }
  env.companies.push(company);
  return company;
}

async function setup() {
  const env = await http.setup();
  env.companies = [];
  env.src = { admin: env.admin, created: [] };
  env.cX = await newCompany(env, 'Imobiliária');
  env.cY = await newCompany(env, 'Construtora');
  env.cZ = await newCompany(env, 'Sem vínculo', { member: false });
  env.formulaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d625-formulas-'));
  for (const code of Object.values(CODES)) {
    fs.writeFileSync(path.join(env.formulaDir, `${code.replace('.', '_')}.js`), `module.exports = { id: '${code}', version: 1, compute: () => ({ value: '1' }),
      testCases: [{ name: 'um', input: [], expected: { value: '1' } }] };`);
  }
  env.catalog = registry.createFormulaCatalog(env.formulaDir);
  registerConsolidationRule(CODES.revenue, { kind: 'SUM', intercompany: { side: 'IN', phase: 'SETTLED' } });
  registerConsolidationRule(CODES.cost, { kind: 'SUM', intercompany: { side: 'OUT', phase: 'SETTLED' } });
  registerConsolidationRule(CODES.rate, { kind: 'RATE', numeratorDimension: 'numerador', denominatorDimension: 'denominador' });
  for (const t of [env.cX, env.cY]) for (const code of Object.values(CODES)) await publish(env, t, code);
  return env;
}

const publish = (env, t, code) => http.inTx(t, { commit: true, writer: true }, (tx) => registry.publishMetric({
  scopeLevel: 'COMPANY', metricCode: code, name: `Teste ${code}`, description: 'd', formulaId: code, formulaSemantic: 'teste', sourceReadModel: 'rm_finance_health', dimensions: [], filters: {},
  unit: UNITS[code], ownerRole: 'CFO', refreshPolicy: { mode: 'SCHEDULE', cron: '0 3 * * *', maxStalenessMinutes: 60 }, version: 1, validFrom: '2026-01-01',
  qualityRule: { referenceReport: 'r' }, valueNature: 'ACTUAL', criticality: 'NORMAL', drilldownEnabled: false,
}, http.ctxOf(t, ['analytics:manage']), tx, { catalog: env.catalog }));

/** Grava o snapshot do indicador de teste na empresa (valor principal ou de uma dimensão), com o período do mês. */
async function snapshot(env, t, code, value, { dimensionKey = '', status = 'OK', asOf = AS_OF, period = ['2026-10-01', '2026-10-31'] } = {}) {
  const [[m]] = await env.admin.query(
    `SELECT d.id AS "metricId", d.current_version_id AS "metricVersionId" FROM analytics.metric_definitions d WHERE d.company_id = :c AND d.metric_code = :code`, { replacements: { c: t.companyId, code } });
  await http.inTx(t, { commit: true, writer: true }, (tx) => store.recordSnapshot({
    ...m, groupId: t.groupId, companyId: t.companyId, scopeType: 'COMPANY', scopeId: t.companyId, periodStart: period[0], periodEnd: period[1], asOfDate: asOf, dimensionKey,
    valueNumeric: value, status, sourceSnapshotAt: NOW, readModelVersion: 1, sourceRefs: [], calcHash: crypto.createHash('sha256').update(`m9d625|${t.companyId}|${code}|${dimensionKey}|${value}`).digest('hex'),
  }, tx));
}

/** Transferência entre empresas como o Financeiro grava: saída na origem, entrada no destino e a transferência (origem dona). `opts`: amount, toAmount, fromStatus, toStatus, settled. */
async function transfer(env, from, to, opts = {}) {
  const id = ledger.uuid();
  const settledAt = opts.settled || '2026-10-20T15:00:00.000Z';
  const leg = (t, type, side, amount, status) => ledger.insert(env.src, 'financial_entries', t, {
    entry_type: type, nature: 'ADJUSTMENT', amount, status, due_at: opts.due || settledAt, settled_at: status === 'SETTLED' ? settledAt : null, idempotency_key: `intercompany-transfer:${id}:${side}`,
  });
  const amount = opts.amount || '10000.00';
  const fromEntry = await leg(from, 'DEBIT', 'from', amount, opts.fromStatus || 'SETTLED');
  const toEntry = await leg(to, 'CREDIT', 'to', opts.toAmount || amount, opts.toStatus || 'SETTLED');
  await ledger.insert(env.src, 'intercompany_transfers', from, {
    id, from_company_id: from.companyId, to_company_id: to.companyId, amount, reason: 'Repasse entre empresas', status: 'PENDING', from_entry_id: fromEntry, to_entry_id: toEntry,
    evidence_file_id: ledger.uuid(), from_bank_account_id: ledger.uuid(), to_bank_account_id: ledger.uuid(), requested_by_user_id: from.userId,
  });
  return { id, fromEntry, toEntry };
}

const event = (t, eventType = 'finance.intercompany_transfer.approved') => ({
  id: ledger.uuid(), eventType, companyId: t.companyId, groupId: t.groupId, aggregateId: ledger.uuid(), payloadJson: { id: ledger.uuid() }, occurredAt: NOW, retryCount: 0,
});
/** Atualiza o read model rm_finance_intercompany da empresa de origem (worker de eventos). */
const refreshPairs = (t) => http.inTx(t, { commit: true }, (tx) => readModels.applyEvent(event(t), tx, { now: NOW }));
const pairRows = async (env, t) => (await env.admin.query('SELECT * FROM analytics.rm_finance_intercompany WHERE company_id = :c ORDER BY transfer_id', { replacements: { c: t.companyId } }))[0];

const get = (env, code, { perms = GROUP_PERMS, tenant = 'A', groupId = env.tenantA.groupId, extra = '' } = {}) => env.call('GET',
  `/analytics/metrics/${code}?groupId=${groupId}&asOf=${AS_OF}${extra}`, { perms, tenant });

async function teardown(env) {
  const ids = env.companies.map((c) => c.companyId);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction });
    for (const t of FIN_TABLES) await env.admin.query(`DELETE FROM finance.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    for (const t of ['metric_snapshots']) await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_versions WHERE metric_id IN (SELECT id FROM analytics.metric_definitions WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('UPDATE analytics.metric_definitions SET current_version_id = NULL WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    for (const t of ['rm_finance_intercompany', 'rm_finance_health', 'rm_finance_sector_margin', 'rm_applied_events', 'rm_stale_aggregates', 'read_model_refreshes', 'data_quality_checks']) {
      await env.admin.query(`DELETE FROM analytics.${t} WHERE company_id IN (:ids)`, { replacements: { ids }, transaction });
    }
    await env.admin.query('DELETE FROM core.user_memberships WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.role_permissions WHERE role_id IN (SELECT id FROM core.roles WHERE company_id IN (:ids))', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.roles WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.tenant_settings WHERE company_id IN (:ids)', { replacements: { ids }, transaction });
    await env.admin.query('DELETE FROM core.companies WHERE id IN (:ids)', { replacements: { ids }, transaction });
  });
  fs.rmSync(env.formulaDir, { recursive: true, force: true });
  await http.teardown(env);
}

module.exports = { setup, teardown, newCompany, publish, snapshot, transfer, refreshPairs, pairRows, get, event, AS_OF, NOW, CODES, GROUP_PERMS, inTx: http.inTx, ledger };
