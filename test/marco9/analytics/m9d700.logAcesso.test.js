'use strict';

// M9-D700 — log de acesso (imutável), mascaramento na saída segura e ABAC por carteira. Roda SÓ em banco descartável:
//   node scripts/withDisposableDb.js --port <porta> -- env ... bash -c "node scripts/seed-ci-two-tenants.js >/dev/null && NODE_ENV=test node --test --test-concurrency=1 test/marco9/analytics/m9d700.logAcesso.test.js"
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sup = require('../_helpers/analyticsHttpEnv');
const security = require('../../../src/features/analytics/security');
const { upsertSetting } = require('../../../src/features/settings/settings.service');

const { inTx, ctxOf, sequelize } = sup;
let env;

before(async () => { env = await sup.setup(); });
after(() => sup.teardown(env));

const A = () => env.tenantA;
const ALL = ['analytics:read', 'analytics:drilldown', 'analytics:export', 'analytics:brief:read', 'finance:read', 'analytics:audit:read'];

async function logOf(where, replacements = {}) {
  const [rows] = await env.admin.query(`SELECT * FROM analytics.access_log WHERE ${where} ORDER BY occurred_at`, { replacements });
  return rows;
}

async function setParam(key, value) {
  await sequelize.transaction(async (transaction) => {
    await sequelize.query("SELECT set_config('app.group_id', :g, true), set_config('app.company_id', :c, true), set_config('app.user_id', :u, true)",
      { replacements: { g: A().groupId, c: A().companyId, u: A().userId }, transaction });
    await upsertSetting(key, value, A(), A().userId, transaction);
  });
}

const LINHAS = [{ cliente: 'Maria', cpf: '123.456.789-01', conta: '0001234-5', email: 'maria@x.com', telefone: '11987654321', party_name: 'Ana Souza', valor: 100 }];

test('m9d700 campo RESTRICTED sai sempre mascarado no detalhe e na exportação, e o acesso gera log', async () => {
  const resourceCode = `fin.mask_${sup.sfx()}`;
  for (const [action, permission] of [['DRILLDOWN', 'analytics:drilldown'], ['EXPORT_GENERATE', 'analytics:export']]) {
    const { rows, maskedCount } = await security.prepareSecureRows(ctxOf(A(), ALL), {
      permission, domain: 'FINANCE', action, resourceType: 'METRIC', resourceCode: `${resourceCode}.${action}`, route: `teste ${action}`,
      filters: { periodo: '2026-10', cpf: '123.456.789-01' }, rows: LINHAS, ip: '203.0.113.9',
    });
    assert.equal(maskedCount, 5);
    assert.deepEqual(rows[0], { cliente: 'Maria', cpf: '***.456.789-**', conta: '****2345', email: 'm***@x.com', telefone: '(11) *****-4321', party_name: 'A. S.', valor: 100 });
    assert.ok(!JSON.stringify(rows).includes('123.456.789-01'));
    const [log] = await logOf('resource_code = :c', { c: `${resourceCode}.${action}` });
    assert.equal(log.action, action);
    assert.equal(log.rows_returned, 1);
    assert.equal(log.masking_applied, true);
    assert.equal(log.user_id, A().userId);
    assert.match(log.ip_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(log.ip_hash, '203.0.113.9');
    assert.equal(log.filters.cpf, '***.456.789-**', 'o filtro do log também sai mascarado');
    assert.ok(!JSON.stringify(log).includes('203.0.113.9'));
  }
  // sem a permissão do BI ou do domínio não há saída nem log
  const semExport = ctxOf(A(), ['analytics:read', 'finance:read']);
  await assert.rejects(security.prepareSecureRows(semExport, { permission: 'analytics:export', action: 'EXPORT_GENERATE', resourceType: 'METRIC', rows: LINHAS }), (e) => e.code === 'PERMISSION_DENIED');
  await assert.rejects(security.prepareSecureRows(ctxOf(A(), ['analytics:export']), { permission: 'analytics:export', domain: 'FINANCE', action: 'EXPORT_GENERATE', resourceType: 'METRIC', resourceCode: 'sem.dominio', rows: LINHAS }),
    (e) => e.code === 'PERMISSION_DENIED' && e.details.permission === 'finance:read');
  assert.equal((await logOf("resource_code = 'sem.dominio'")).length, 0);
});

test('m9d700 todo drill-down, export e brief gera linha no log de acesso', async () => {
  const marca = `fin.log_${sup.sfx()}`;
  const acoes = [
    ['DRILLDOWN', 'analytics:drilldown'], ['EXPORT_REQUEST', 'analytics:export'], ['EXPORT_GENERATE', 'analytics:export'],
    ['EXPORT_DOWNLOAD', 'analytics:export'], ['BRIEF_GENERATE', 'analytics:brief:read'], ['BRIEF_READ', 'analytics:brief:read'], ['NAY_QUERY', 'analytics:read'],
  ];
  for (const [action, permission] of acoes) {
    await security.prepareSecureRows(ctxOf(A(), ALL), { permission, action, resourceType: 'METRIC', resourceCode: marca, rows: [{ valor: 1 }, { valor: 2 }], ip: '198.51.100.7' });
  }
  const linhas = await logOf('resource_code = :c', { c: marca });
  assert.deepEqual(linhas.map((l) => l.action).sort(), acoes.map(([a]) => a).sort());
  assert.ok(linhas.every((l) => l.rows_returned === 2 && l.masking_applied === false && l.correlation_id !== undefined));
  await assert.rejects(security.recordAccess(ctxOf(A()), { action: 'INVENTADA', resourceType: 'X' }), (e) => e.code === 'ANALYTICS_ACCESS_LOG_ACTION');
});

test('m9d700 leitura do log só com analytics:audit:read e respeita o teto do parâmetro', async () => {
  await inTx(A(), {}, async (tx) => {
    await assert.rejects(security.listAccessLog(ctxOf(A(), ['analytics:read']), {}, tx), (e) => e.code === 'PERMISSION_DENIED' && e.details.permission === 'analytics:audit:read');
    const todos = await security.listAccessLog(ctxOf(A(), ['analytics:audit:read']), { action: 'DRILLDOWN' }, tx);
    assert.ok(todos.length >= 1 && todos.every((l) => l.action === 'DRILLDOWN'));
    await assert.rejects(security.listAccessLog(ctxOf(A(), ['analytics:audit:read']), { action: 'X' }, tx), (e) => e.statusCode === 400);
  });
  await setParam('analytics.log_acesso.consulta_max_linhas', 2);
  try {
    const res = await env.call('GET', '/analytics/access-log?limit=500', { perms: ['analytics:audit:read'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 2, 'o teto vem do parâmetro');
  } finally { await setParam('analytics.log_acesso.consulta_max_linhas', 200); }
});

test('m9d700 log de acesso é imutável', async () => {
  const code = `fin.imutavel_${sup.sfx()}`;
  await security.recordAccess(ctxOf(A()), { action: 'METRIC_READ', resourceType: 'METRIC', resourceCode: code, rowsReturned: 1 });
  // runtime (nayara_runtime): sem política de UPDATE/DELETE (e sem GRANT na migration), a RLS FORCE nega: erro ou zero linhas
  for (const sql of ["UPDATE analytics.access_log SET rows_returned = 99 WHERE resource_code = :c", 'DELETE FROM analytics.access_log WHERE resource_code = :c']) {
    const afetadas = await inTx(A(), { writer: true }, async (tx) => {
      try {
        const [, meta] = await sequelize.query(sql, { replacements: { c: code }, transaction: tx });
        return meta.rowCount ?? 0;
      } catch (e) {
        assert.match(String(e.message), /permission denied|ANA20|não pode ser/i);
        return 0;
      }
    });
    assert.equal(afetadas, 0, `o runtime não pode alterar nem apagar o log: ${sql}`);
  }
  // dono/superusuário: o gatilho recusa UPDATE e DELETE (ANA20)
  await assert.rejects(env.admin.query("UPDATE analytics.access_log SET rows_returned = 99 WHERE resource_code = :c", { replacements: { c: code } }), (e) => e.original?.code === 'ANA20');
  await assert.rejects(env.admin.query('DELETE FROM analytics.access_log WHERE resource_code = :c', { replacements: { c: code } }), (e) => e.original?.code === 'ANA20');
  assert.equal((await logOf('resource_code = :c', { c: code }))[0].rows_returned, 1);
  // expurgo da governança: só com a marca de retenção e executado pelo dono
  const t = await env.admin.transaction();
  try {
    await env.admin.query("SELECT set_config('app.analytics_log_retention', 'on', true)", { transaction: t });
    await env.admin.query('DELETE FROM analytics.access_log WHERE resource_code = :c', { replacements: { c: code }, transaction: t });
    await t.commit();
  } catch (e) { await t.rollback(); throw e; }
  assert.equal((await logOf('resource_code = :c', { c: code })).length, 0);
});

test('m9d700 corretor vê só a própria carteira (ABAC) e a equipe do gerente vem do parâmetro', async () => {
  const tabela = `rm_m9d700_${sup.sfx()}`;
  const outro = '11111111-1111-4111-8111-111111111111';
  await env.admin.query(`CREATE TABLE analytics.${tabela} (id serial, owner_user_id uuid, valor int)`);
  await env.admin.query(`GRANT SELECT ON analytics.${tabela} TO nayara_runtime`);
  await env.admin.query(`INSERT INTO analytics.${tabela} (owner_user_id, valor) VALUES (:me, 1), (:me, 2), (:o, 10), (:o, 20)`, { replacements: { me: A().userId, o: outro } });
  const consulta = async (ctx) => inTx(A(), {}, async (tx) => {
    const scope = await security.resolveRowScope(ctx, tx);
    const f = security.ownerFilter(scope);
    const [rows] = await sequelize.query(`SELECT valor FROM analytics.${tabela} WHERE ${f.clause} ORDER BY valor`, { replacements: f.replacements, transaction: tx });
    return { scope, valores: rows.map((r) => r.valor) };
  });
  try {
    const corretor = await consulta(ctxOf(A(), ['analytics:read', 'crm:opportunities:read', 'crm:opportunities:read:own']));
    assert.equal(corretor.scope.mode, 'SELF');
    assert.deepEqual(corretor.valores, [1, 2], 'só a própria carteira');
    const gerente = await consulta(ctxOf(A(), ['analytics:read', 'crm:opportunities:read:own', 'crm:opportunities:read:all']));
    assert.deepEqual(gerente.valores, [1, 2, 10, 20]);
    const grupo = await consulta(ctxOf(A(), ['analytics:read', 'crm:opportunities:read:own', 'analytics:read:group']));
    assert.equal(grupo.scope.mode, 'ALL');
    await setParam('analytics.abac.equipes', `${A().userId}=${outro}`);
    try {
      const comEquipe = await consulta(ctxOf(A(), ['analytics:read', 'crm:opportunities:read:own']));
      assert.deepEqual(comEquipe.valores, [1, 2, 10, 20], 'a equipe do gerente entra no recorte');
    } finally { await setParam('analytics.abac.equipes', 'nenhuma'); }
  } finally {
    await env.admin.query(`DROP TABLE analytics.${tabela}`);
  }
});
