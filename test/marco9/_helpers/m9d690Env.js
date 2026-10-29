'use strict';

// Apoio dos testes da M9-D690 (drill-down): servidor HTTP com o router real de /analytics, uma tabela de origem por modo de reconciliação
// (COUNT, SUM e RECOMPUTE) com colunas RESTRICTED, métricas publicadas e especificações de origem registradas. Banco descartável (127.0.0.1).
// O que o teste grava com commit (métricas, linhas, log de acesso de teste) é removido em `teardown`.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('./analyticsHttpEnv');
const registry = require('../../../src/features/analytics/metrics');
const { registerDrilldownDetail, unregisterDrilldownDetail } = require('../../../src/features/analytics/metrics/drilldown.details');

const CPF_A = '529.982.247-25';
const CPF_B = '111.444.777-35';
const INSIDE = [
  { amount: '100.10', nature: 'RECEIVABLE', party: 'Maria da Silva Souza', cpf: CPF_A, flag: true },
  { amount: '250.25', nature: 'RECEIVABLE', party: 'José de Souza Lima', cpf: CPF_B, flag: false },
  { amount: '30.00', nature: 'PAYABLE', party: 'Ana Pereira', cpf: CPF_A, flag: true },
  { amount: '70.40', nature: 'RECEIVABLE', party: 'Carlos Alberto Dias', cpf: CPF_B, flag: true },
  { amount: '12.34', nature: 'PAYABLE', party: 'Paula Fernanda Rocha', cpf: CPF_A, flag: false },
];
const PERIOD = Object.freeze({ from: '2026-10-01T03:00:00.000Z', to: '2026-11-01T03:00:00.000Z' });
// code, domínio, unidade, modo esperado, criticidade
const METRICS = [
  { key: 'legal', code: 'legal.m9d690_processos', domain: 'LEGAL', unit: 'COUNT', mode: 'COUNT', criticality: 'CRITICAL', permission: 'legal:read' },
  { key: 'fin', code: 'fin.m9d690_caixa', domain: 'FINANCE', unit: 'BRL', mode: 'SUM', criticality: 'CRITICAL', permission: 'finance:read' },
  { key: 'rent', code: 'rent.m9d690_ocupacao', domain: 'RENTAL', unit: 'PERCENT', mode: 'RECOMPUTE', criticality: 'CRITICAL', permission: 'legal:read' },
  { key: 'mkt', code: 'mkt.m9d690_leads', domain: 'MARKETING', unit: 'COUNT', mode: 'COUNT', criticality: 'CRITICAL', permission: 'marketing:attribution:read' },
  { key: 'sup', code: 'sup.m9d690_chamados', domain: 'SUPPORT', unit: 'COUNT', mode: 'COUNT', criticality: 'CRITICAL', permission: 'crm:feedback:read' },
  { key: 'prop', code: 'prop.m9d690_normal', domain: 'PROPERTIES', unit: 'COUNT', mode: 'COUNT', criticality: 'NORMAL', permission: 'crm:opportunities:read' },
];
const sumSigned = (rows) => rows.reduce((t, r) => t + (r.nature === 'PAYABLE' ? -1 : 1) * Math.round(Number(r.amount) * 100), 0) / 100;

async function setup() {
  const env = await http.setup();
  env.sfx = http.sfx();
  env.metrics = METRICS.map((m) => ({ ...m, table: `m9d690_${m.key}_${env.sfx}` }));
  env.formulaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d690-formulas-'));
  env.readModel = `rm_m9d690_${env.sfx}`;
  await env.admin.query(`CREATE TABLE analytics.${env.readModel} (id int)`);
  for (const m of env.metrics) {
    await env.admin.query(`CREATE TABLE analytics.${m.table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, status text NOT NULL, nature text NOT NULL,
      occurred_at timestamptz NOT NULL, amount numeric(18,2) NOT NULL, cpf_titular text, nome_parte text, flag boolean NOT NULL)`);
    await env.admin.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN GRANT SELECT ON analytics.${m.table} TO nayara_runtime; END IF; END $$`);
    const rows = [
      ...INSIDE.map((r, i) => ({ ...r, company: env.tenantA.companyId, status: 'OK', at: `2026-10-${String(5 + i).padStart(2, '0')}T15:00:00Z` })),
      { ...INSIDE[0], company: env.tenantB.companyId, status: 'OK', at: '2026-10-05T15:00:00Z' },
      { ...INSIDE[0], company: env.tenantA.companyId, status: 'CANCELADO', at: '2026-10-05T15:00:00Z' },
      { ...INSIDE[0], company: env.tenantA.companyId, status: 'OK', at: '2026-09-30T15:00:00Z' },
    ];
    for (const r of rows) {
      await env.admin.query(`INSERT INTO analytics.${m.table} (company_id, status, nature, occurred_at, amount, cpf_titular, nome_parte, flag) VALUES (:c, :s, :n, :o, :a, :cpf, :p, :f)`,
        { replacements: { c: r.company, s: r.status, n: r.nature, o: r.at, a: r.amount, cpf: r.cpf, p: r.party, f: r.flag } });
    }
    m.formulaId = `${m.code.replace('.', '_')}_f`;
    fs.writeFileSync(path.join(env.formulaDir, `${m.key}.js`), `module.exports = { id: '${m.formulaId}', version: 1,
      compute: (rows) => ({ value: String(rows.filter((r) => r.flag === 'true').length) }), testCases: [{ name: 'um', input: [{ flag: 'true' }], expected: { value: '1' } }] };`);
    registry.registerSourceSpec({
      metricCode: m.code, type: `TESTE_${m.key.toUpperCase()}`, table: `analytics.${m.table}`, columns: { period: 'occurred_at', status: 'status', nature: 'nature' },
      ...(m.mode === 'SUM' ? { valueColumn: 'amount', valueSign: { column: 'nature', negative: ['PAYABLE'] } } : {}),
      ...(m.mode === 'RECOMPUTE' ? { formulaId: m.formulaId, rowColumns: ['flag'] } : {}),
      describe: (f) => `Linhas de teste ${m.key} da empresa no período ${f.period.from} a ${f.period.to}`,
    });
    registerDrilldownDetail(m.code, { columns: ['cpf_titular', 'nome_parte'], link: `/painel/teste/${m.key}/{id}` });
  }
  env.catalog = registry.createFormulaCatalog(env.formulaDir);
  env.publish = (m) => http.inTx(env.tenantA, { commit: true, writer: true }, (tx) => registry.publishMetric({
    scopeLevel: 'COMPANY', metricCode: m.code, name: `Teste ${m.key}`, description: 'd', formulaId: m.formulaId, formulaSemantic: 'teste', sourceReadModel: env.readModel,
    dimensions: [], filters: {}, unit: m.unit, ownerRole: 'CFO', refreshPolicy: { mode: 'SCHEDULE', cron: '0 3 * * *', maxStalenessMinutes: 60 },
    version: 1, validFrom: '2026-01-01', qualityRule: { referenceReport: 'r' }, valueNature: 'ACTUAL', criticality: m.criticality, drilldownEnabled: false,
  }, http.ctxOf(env.tenantA, ['analytics:manage']), tx, { catalog: env.catalog }));
  for (const m of env.metrics) await env.publish(m);
  return env;
}

async function teardown(env) {
  try {
    await cleanup(env);
  } finally {
    await http.teardown(env);
  }
}

async function cleanup(env) {
  const codes = env.metrics.map((m) => m.code);
  await env.admin.transaction(async (transaction) => {
    await env.admin.query("SET LOCAL session_replication_role = 'replica'", { transaction }); // contorna só aqui o gatilho de imutabilidade da versão publicada
    const ids = '(SELECT id FROM analytics.metric_definitions WHERE metric_code IN (:codes))';
    await env.admin.query(`DELETE FROM analytics.metric_snapshots WHERE metric_id IN ${ids}`, { replacements: { codes }, transaction });
    await env.admin.query(`DELETE FROM analytics.metric_versions WHERE metric_id IN ${ids}`, { replacements: { codes }, transaction });
    await env.admin.query('DELETE FROM analytics.metric_definitions WHERE metric_code IN (:codes)', { replacements: { codes }, transaction });
  });
  for (const m of env.metrics) {
    registry.unregisterSourceSpec(m.code);
    unregisterDrilldownDetail(m.code);
    await env.admin.query(`DROP TABLE IF EXISTS analytics.${m.table}`);
  }
  await env.admin.query(`DROP TABLE IF EXISTS analytics.${env.readModel}`);
  fs.rmSync(env.formulaDir, { recursive: true, force: true });
}

const ADMIN_PERMS = (m) => ['analytics:read', 'analytics:drilldown', m.permission];

/** Item de sourceRefs (filter, filterHash, filterSignature) do filtro de teste, gerado por quem tem o detalhe. */
async function refOf(env, m, filter = { period: PERIOD, status: ['OK'] }) {
  return http.inTx(env.tenantA, {}, async (tx) => {
    const ctx = http.ctxOf(env.tenantA, ADMIN_PERMS(m));
    return (await registry.buildSourceRefs(ctx, m.code, { filter }, tx)).sourceRefs[0];
  });
}

const query = (ref, extra = {}) => {
  const q = new URLSearchParams({ filter: JSON.stringify(ref.filter), filterHash: ref.filterHash, filterSignature: ref.filterSignature, ...extra });
  return q.toString();
};

const get = (env, m, ref, { perms = ADMIN_PERMS(m), tenant = 'A', extra = {} } = {}) => env.call('GET', `/analytics/metrics/${m.code}/drilldown?${query(ref, extra)}`, { perms, tenant });

async function accessLog(env, code) {
  const [rows] = await env.admin.query(
    "SELECT action, rows_returned, masking_applied, filters, user_id, company_id FROM analytics.access_log WHERE resource_code = :code AND action = 'DRILLDOWN' ORDER BY occurred_at", { replacements: { code } }
  );
  return rows;
}

module.exports = { ...http, setup, teardown, refOf, get, query, accessLog, sumSigned, INSIDE, PERIOD, CPF_A, ADMIN_PERMS };
