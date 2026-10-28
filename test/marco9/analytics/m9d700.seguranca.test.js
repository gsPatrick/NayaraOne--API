'use strict';

// M9-D700 — permissões, escopo entre empresas, RLS por tabela, log de acesso imutável e ABAC. Roda SÓ em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/analytics/m9d700.seguranca.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../_helpers/analyticsHttpEnv');
const security = require('../../../src/features/analytics/security');
const registry = require('../../../src/features/analytics/metrics');
const analytics = require('../../../src/features/analytics');

const { inTx, ctxOf, sequelize } = sup;
let env;

before(async () => { env = await sup.setup(); });
after(() => sup.teardown(env));

const A = () => env.tenantA;
const B = () => env.tenantB;

// ---------------------------------------------------------------- 1
test('m9d700 RLS/permissões valem para BI e exportação (matriz de rotas x permissões)', async () => {
  const rotas = analytics.listAnalyticsRoutes(env.router).filter((r) => !r.path.includes('/probe'));
  assert.ok(rotas.length >= 3, 'a varredura precisa enxergar as rotas do BI');
  const perfis = {
    'sem permissão': [],
    'só analytics:read': ['analytics:read'],
    'leitor financeiro': ['analytics:read', 'finance:read'],
    'só analytics:manage': ['analytics:manage'],
    'auditor': ['analytics:audit:read'],
  };
  const tabela = [];
  for (const rota of rotas) {
    const caminho = rota.path.replace(':code', 'finance').replace(':id', '00000000-0000-4000-8000-000000000000');
    const linha = { rota: `${rota.method} ${rota.path}` };
    for (const [nome, perms] of Object.entries(perfis)) {
      const res = await env.call(rota.method, caminho, { perms, body: rota.method === 'GET' ? undefined : {} });
      linha[nome] = res.status;
      if (nome === 'sem permissão') {
        assert.equal(res.status, 403, `${linha.rota} sem permissão deveria dar 403 e deu ${res.status}`);
        assert.equal(res.body.error.code, 'PERMISSION_DENIED');
      }
    }
    tabela.push(linha);
  }
  console.log('[matriz de permissões] rota x perfil (status HTTP)');
  console.table(tabela);
  const acesso = tabela.find((l) => l.rota === 'GET /analytics/access-log');
  assert.equal(acesso['só analytics:read'], 403, 'log de acesso só com analytics:audit:read');
  assert.equal(acesso.auditor, 200);
});

test('m9d700 métrica de domínio sem permissão devolve 403 e com a permissão de origem passa', async () => {
  const { metricCode, cleanup } = await sup.publishTestMetric(env, { prefix: 'fin' });
  try {
    await inTx(A(), {}, async (tx) => {
      const corretor = ctxOf(A(), ['analytics:read', 'crm:opportunities:read']);
      const req = { metricCode, scopeType: 'COMPANY', scopeId: A().companyId, asOfDate: '2026-10-31' };
      await assert.rejects(registry.readMetricValue(corretor, req, tx), (e) => e.statusCode === 403 && e.code === 'PERMISSION_DENIED' && e.details.permission === 'finance:read');
      await assert.rejects(registry.getMetric(corretor, metricCode, tx), (e) => e.code === 'PERMISSION_DENIED');
      assert.ok(!(await registry.listRegistry(corretor, {}, tx)).some((m) => m.metricCode === metricCode), 'a lista não mostra o que o usuário não pode ver');
      const financeiro = ctxOf(A(), ['analytics:read', 'finance:read']);
      assert.ok((await registry.listRegistry(financeiro, {}, tx)).some((m) => m.metricCode === metricCode));
      await assert.rejects(registry.readMetricValue(financeiro, req, tx), (e) => e.code === 'ANALYTICS_SNAPSHOT_NOT_AVAILABLE', 'passou pela permissão e só falta o snapshot');
    });
  } finally { cleanup(); }
});

// ---------------------------------------------------------------- 2
test('m9d700 cross-company bloqueado em toda rota de analytics', async () => {
  const dono = await env.call('GET', '/analytics/access-log', { perms: ['analytics:audit:read'] });
  assert.equal(dono.status, 200);
  const outroGrupo = await env.call('GET', `/analytics/metrics/fin.qualquer?companyId=${B().companyId}`, { perms: ['analytics:read', 'finance:read'] });
  assert.equal(outroGrupo.status, 404);
  assert.equal(outroGrupo.body.error.code, 'ANALYTICS_SCOPE_NOT_FOUND');
  await inTx(A(), {}, async (tx) => {
    assert.equal(await security.resolveCompanyScope(ctxOf(A()), undefined, tx), A().companyId);
    assert.equal(await security.resolveCompanyScope(ctxOf(A()), A().companyId, tx), A().companyId);
    for (const alvo of [B().companyId, '00000000-0000-4000-8000-000000000000', 'nao-e-uuid', 123]) {
      await assert.rejects(security.resolveCompanyScope(ctxOf(A()), alvo, tx), (e) => e.statusCode === 404 && e.code === 'ANALYTICS_SCOPE_NOT_FOUND', String(alvo));
    }
  });
  // o log da empresa A não aparece para a empresa B
  await security.recordAccess(ctxOf(A()), { action: 'METRIC_READ', resourceType: 'METRIC', resourceCode: 'fin.isolamento_m9d700', rowsReturned: 1 });
  const visto = await env.call('GET', '/analytics/access-log?limit=1000', { perms: ['analytics:audit:read'], tenant: 'B' });
  assert.equal(visto.status, 200);
  assert.ok(!visto.body.data.some((l) => l.resourceCode === 'fin.isolamento_m9d700'));
});

// ---------------------------------------------------------------- 3
test('m9d700 RLS nas tabelas e read models de analytics (duas empresas)', async () => {
  const [tabelas] = await env.admin.query(
    `SELECT c.relname AS tabela, c.relrowsecurity AS rls, c.relforcerowsecurity AS forca,
            EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'company_id' AND NOT a.attisdropped) AS tem_empresa,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS politicas
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'analytics' AND c.relkind = 'r' AND c.relname NOT LIKE 'rm\\_m9d6%' ORDER BY 1`
  );
  assert.ok(tabelas.length >= 10, 'esperava as tabelas do BI');
  assert.ok(tabelas.some((t) => t.tabela === 'access_log'));
  for (const t of tabelas) {
    assert.equal(t.rls, true, `analytics.${t.tabela}: RLS`);
    assert.equal(t.forca, true, `analytics.${t.tabela}: FORCE RLS`);
    assert.ok(t.politicas >= 1, `analytics.${t.tabela}: sem política`);
  }
  // linha de B inserida pelo superusuário (sem RLS): a sessão da empresa A não enxerga, não altera e não apaga
  const outroPainel = `m9d700_${sup.sfx()}`;
  await env.admin.query(
    `INSERT INTO analytics.dashboard_definitions (company_id, group_id, dashboard_code, name, domain, status, version, required_permission)
     VALUES (:c, :g, :code, 'B', 'FINANCE', 'DRAFT', 1, 'finance:read')`, { replacements: { c: B().companyId, g: B().groupId, code: outroPainel } });
  await env.admin.query(
    `INSERT INTO analytics.access_log (company_id, group_id, action, resource_type, resource_code) VALUES (:c, :g, 'METRIC_READ', 'METRIC', 'fin.da_empresa_b')`,
    { replacements: { c: B().companyId, g: B().groupId } });
  for (const t of tabelas.filter((x) => x.tem_empresa)) {
    const [[doAdmin]] = await env.admin.query(`SELECT count(*)::int AS n FROM analytics.${t.tabela} WHERE company_id = :b`, { replacements: { b: B().companyId } });
    await inTx(A(), { writer: true }, async (tx) => {
      const [[sel]] = await sequelize.query(`SELECT count(*)::int AS n FROM analytics.${t.tabela} WHERE company_id = :b`, { replacements: { b: B().companyId }, transaction: tx });
      assert.equal(sel.n, 0, `analytics.${t.tabela}: A viu ${sel.n} linha(s) de B (admin vê ${doAdmin.n})`);
      if (t.tabela !== 'access_log') {
        const [, upd] = await sequelize.query(`UPDATE analytics.${t.tabela} SET company_id = company_id WHERE company_id = :b`, { replacements: { b: B().companyId }, transaction: tx });
        assert.equal(upd.rowCount ?? 0, 0, `analytics.${t.tabela}: UPDATE atingiu linhas de B`);
        const [, del] = await sequelize.query(`DELETE FROM analytics.${t.tabela} WHERE company_id = :b`, { replacements: { b: B().companyId }, transaction: tx });
        assert.equal(del.rowCount ?? 0, 0, `analytics.${t.tabela}: DELETE atingiu linhas de B`);
      }
    });
  }
  const [[ainda]] = await env.admin.query('SELECT count(*)::int AS n FROM analytics.dashboard_definitions WHERE dashboard_code = :c', { replacements: { c: outroPainel } });
  assert.equal(ainda.n, 1, 'a linha de B continua intacta');
  // painel de GRUPO de B também não aparece para A
  const painelGrupo = `m9d700g_${sup.sfx()}`;
  await env.admin.query(
    `INSERT INTO analytics.dashboard_definitions (group_id, dashboard_code, name, domain, status, version, required_permission)
     VALUES (:g, :code, 'Grupo B', 'FINANCE', 'DRAFT', 1, 'finance:read')`, { replacements: { g: B().groupId, code: painelGrupo } });
  await inTx(A(), {}, async (tx) => {
    const [[n]] = await sequelize.query('SELECT count(*)::int AS n FROM analytics.dashboard_definitions WHERE dashboard_code = :c', { replacements: { c: painelGrupo }, transaction: tx });
    assert.equal(n.n, 0);
  });
});
