'use strict';

// M9-D608 (3.1) — o comando operacional scripts/analytics/rebuildReadModel.js: argumentos, identidade com a permissão analytics:rebuild,
// parâmetro por ambiente e saída com hash antes e depois. Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env608 = require('../_helpers/m9d608Env');
const { runCli, parseArgs } = require('../../../scripts/analytics/rebuildCli');

const { addSource, applyCommitted, lastRefresh } = env608;
const SCRIPT = path.join(__dirname, '../../../scripts/analytics/rebuildReadModel.js');
let env;

let grantedRoleIds = [];

before(async () => {
  env = await env608.setup();
  // o administrador de seed precisa ter a permissão analytics:rebuild na empresa (no banco descartável a seed de papéis vem depois da migration do catálogo)
  const [granted] = await env.admin.query(`INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
    SELECT gen_random_uuid(), m.role_id, p.id, now(), now() FROM core.user_memberships m, core.permissions p
     WHERE m.user_id = :u AND m.company_id = :c AND m.status = 'ACTIVE' AND p.code = 'analytics:rebuild'
       AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = m.role_id AND rp.permission_id = p.id)
    RETURNING id`, { replacements: { u: env.tenantA.userId, c: env.tenantA.companyId } });
  grantedRoleIds = granted.map((r) => r.id);
  await addSource(env, env.tenantA, 'caixa', '119000.00');
  await addSource(env, env.tenantA, 'caixa', '1000.00');
  await applyCommitted(env, env.tenantA, 'caixa');
});
after(async () => {
  if (grantedRoleIds.length) await env.admin.query('DELETE FROM core.role_permissions WHERE id IN (:ids)', { replacements: { ids: grantedRoleIds } });
  await env608.teardown(env);
});

async function cli(args) {
  const out = [];
  const err = [];
  const code = await runCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const base = () => [`--model=${env.model}`, `--company=${env.tenantA.companyId}`, `--user=${env.tenantA.userId}`];

test('m9d608 comando lê os argumentos e recusa uso incorreto', async () => {
  assert.deepEqual(parseArgs(['--model=rm_a', '--company=all', '--user=x@y.z', '--motivo= Erro de integração ']), { model: 'rm_a', company: 'all', user: 'x@y.z', reason: 'Erro de integração' });
  for (const args of [[], [`--model=${env.model}`], [`--model=${env.model}`, '--company=abc', '--user=a'], [`--model=${env.model}`, `--company=${env.tenantA.companyId}`]]) {
    const r = await cli(args);
    assert.equal(r.code, 2);
    assert.match(r.err, /Uso: node scripts\/analytics\/rebuildReadModel.js/);
  }
  const noUser = await cli([`--model=${env.model}`, `--company=${env.tenantA.companyId}`, '--user=ninguem@nao.existe']);
  assert.equal(noUser.code, 1);
  assert.match(noUser.err, /Usuário não encontrado/);
});

test('m9d608 comando reconstrói e imprime hash antes e depois', async (t) => {
  const r = await cli([...base(), '--motivo=Execução de teste']);
  t.diagnostic(`saída do comando: ${r.out}`);
  assert.equal(r.code, 0, r.err);
  const refresh = await lastRefresh(env, env.tenantA);
  assert.match(r.out, new RegExp(`hash antes ${refresh.rebuild_diff.before.hash}; hash depois ${refresh.rebuild_diff.after.hash}`));
  assert.match(r.out, /1 -> 1 linhas/);
  const byEmail = await cli([`--model=${env.model}`, `--company=${env.tenantA.companyId}`, '--user=admin@nayaraone.dev']);
  assert.equal(byEmail.code, 0, byEmail.err);
  assert.equal(JSON.stringify(refresh.rebuild_diff.before.hash).length, 66);
});

test('m9d608 comando recusa quem não tem a permissão e o ambiente com a flag desligada', async (t) => {
  const [[ci]] = await env.admin.query("SELECT id FROM core.companies WHERE name = 'CI — Empresa Fictícia A'");
  const denied = await cli([`--model=${env.model}`, `--company=${ci.id}`, '--user=ci-a-leitura@ci.nayaraone.test']);
  assert.equal(denied.code, 1);
  assert.match(denied.err, /PERMISSION_DENIED/);

  process.env.DEPLOY_ENVIRONMENT = 'production';
  try {
    const off = await cli(base());
    assert.equal(off.code, 1);
    t.diagnostic(`recusa com a flag desligada: ${off.err}`);
    assert.match(off.err, /ANALYTICS_REBUILD_DISABLED.*Reconstrução desabilitada neste ambiente\./);
  } finally {
    delete process.env.DEPLOY_ENVIRONMENT;
  }
  const notFound = await cli([`--model=rm_nao_existe`, `--company=${env.tenantA.companyId}`, `--user=${env.tenantA.userId}`]);
  assert.match(notFound.err, /ANALYTICS_READ_MODEL_NOT_FOUND/);
});

test('m9d608 o arquivo do script roda de ponta a ponta (processo separado)', () => {
  const usage = spawnSync(process.execPath, [SCRIPT], { env: process.env, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Uso: node scripts\/analytics\/rebuildReadModel.js/);
  const unknown = spawnSync(process.execPath, [SCRIPT, '--model=rm_nao_existe', `--company=${env.tenantA.companyId}`, `--user=${env.tenantA.userId}`], { env: process.env, encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /ANALYTICS_READ_MODEL_NOT_FOUND/);
});
