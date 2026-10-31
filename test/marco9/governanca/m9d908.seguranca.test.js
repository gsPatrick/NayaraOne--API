'use strict';

// M9-D908 §6 — o ensaio só roda em banco descartável (recusa fora dele), as rotas exigem governance:migration:run, o relatório é da empresa e a prontidão do GO é registrada no
// ponto de extensão da D907. Banco descartável. Nunca chama MFA.
process.env.PORT = process.env.M9D908_HTTP_TEST_PORT || '21908';

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d908Dry');
const http = require('../_helpers/m9d806Http');

const RUN = 'governance:migration:run';
let h; let A;
const call = (who, method, path, body) => h.call(who, method, path, body);

async function grant(role, codes) {
  await env.adminQuery('DELETE FROM core.role_permissions rp USING core.roles r, core.permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.name = $1 AND p.code = ANY($2)', [role, [RUN]]);
  if (codes.length) {
    await env.adminQuery(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
      SELECT gen_random_uuid(), r.id, p.id, now(), now() FROM core.roles r CROSS JOIN core.permissions p WHERE r.name = $1 AND p.code = ANY($2)`, [role, codes]);
  }
}
const reports = async () => Number((await env.adminQuery('SELECT count(*) AS n FROM governance.mig_dry_reports WHERE company_id = $1', [A.companyId])).rows[0].n);

before(async () => {
  await grant('CI GESTOR', [RUN]);
  await grant('CI LEITURA', []);
  h = await http.startHttp({ port: process.env.PORT, grants: {}, logins: { gestor: ['A', 'gestor'], leitura: ['A', 'leitura'], gestorB: ['B', 'gestor'] } });
  if (h.skip) return;
  A = h.tenants.A;
  await env.cleanup(A);
});
afterEach(async () => { if (h && !h.skip) { await env.cleanup(A); await env.isolate(A); } });
after(async () => { if (h && !h.skip) { await grant('CI GESTOR', []); await env.cleanup(A); } await http.stopHttp({}); });

test('m9d908 as duas rotas do ensaio exigem governance:migration:run (403 com a mensagem do livro)', async (t) => {
  if (h.skip) return t.skip(h.skip);
  for (const [method, path, body] of [['POST', '/migration/dry-runs', {}], ['GET', '/migration/dry-runs/00000000-0000-4000-8000-000000000908/report']]) {
    const res = await call('leitura', method, path, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual([res.body.error.code, res.body.error.message], ['PERMISSION_DENIED', `Permissão ausente: ${RUN}.`]);
  }
  assert.equal(await reports(), 0, 'nada foi gravado');
});

test('m9d908 ensaio recusa rodar no banco compartilhado', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const marked = process.env.DISPOSABLE_DB;
  delete process.env.DISPOSABLE_DB;
  try {
    const res = await call('gestor', 'POST', '/migration/dry-runs', {});
    assert.equal(res.status, 409);
    assert.deepEqual([res.body.error.code, res.body.error.message], ['GOV_MIG_DRY_SHARED_DB', 'O ensaio só roda em banco descartável; este é um banco compartilhado.']);
    assert.ok(res.body.error.traceId);
    assert.equal(await reports(), 0, 'nem o relatório foi aberto');
  } finally { process.env.DISPOSABLE_DB = marked; }
  // banco fora desta máquina também é recusado, mesmo com a marca de descartável
  const config = env.sequelize.config;
  const host = config.host;
  config.host = 'banco-de-homologacao.exemplo.com.br';
  try {
    const refused = await env.fail(env.dry.openDryRun(A, { userId: A.userId }));
    assert.deepEqual([refused.status, refused.code], [409, 'GOV_MIG_DRY_SHARED_DB']);
  } finally { config.host = host; }
  assert.equal(await reports(), 0);
});

test('m9d908 POST abre o relatório (202), o ensaio termina e o GET devolve o relatório só da empresa', async (t) => {
  if (h.skip) return t.skip(h.skip);
  await env.isolate(A);
  env.useTempExport();
  const started = await call('gestor', 'POST', '/migration/dry-runs', {});
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const id = started.body.data.id;
  let report;
  for (let i = 0; i < 120; i += 1) {
    report = (await call('gestor', 'GET', `/migration/dry-runs/${id}/report`)).body.data;
    if (report && report.status !== 'RUNNING') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.conclusion, 'REPROVADO', 'sem fonte nenhuma não há o que aprovar');
  assert.equal(report.criteria.counts_match.ok, false);
  assert.equal(report.phases[0].name, 'CLOCK');
  assert.equal((await call('gestor', 'GET', '/migration/dry-runs/not-a-uuid/report')).status, 404);
  assert.equal((await call('gestor', 'GET', '/migration/dry-runs/00000000-0000-4000-8000-000000000908/report')).status, 404);
  const other = await call('gestorB', 'GET', `/migration/dry-runs/${id}/report`);
  assert.equal(other.status, 404, 'outra empresa não vê o relatório');
});

test('m9d908 o ponto de extensão da prontidão do GO e o provedor de blocker do relógio estão registrados', async (t) => {
  if (h.skip) return t.skip(h.skip);
  const readiness = require('../../../src/features/migration-v2/rollback/readiness');
  const gaps = await env.openTenantTx(A, (tx) => readiness.collect(env.tenantOf(A), tx));
  assert.ok(gaps.some((g) => g.code === 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED'));
});
