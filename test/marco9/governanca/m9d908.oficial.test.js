'use strict';

// M9-D908 (reabertura da rodada 4): R4-M2 caminho oficial do relatório até o GO de produção (contêiner sem .git, relatório em volume montado, commit do build);
// R4-L7 commit normalizado (SHA abreviado ou em maiúsculas) e árvore suja no laboratório recusada. Banco descartável para o GO; os puros rodam sem banco.
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../_helpers/m9d908Dry');
const reports = require('../_helpers/m9d908Report');
const { normalizeCommit, sameCommit, resolveCommit, treeDirty } = require('../../../src/features/migration-v2/dryrun/dry.commit');
const { exportReport } = require('../../../src/features/migration-v2/dryrun/dry.export');

let A;
const skip = () => (env.DISPOSABLE ? false : env.SKIP_DISPOSABLE);
before(async () => { if (!env.DISPOSABLE) return; A = (await env.loadTenants()).A; await env.cleanup(A); });
afterEach(async () => { if (env.DISPOSABLE) await env.cleanup(A); });
after(async () => { if (env.DISPOSABLE) await env.cleanup(A); await env.sequelize.close(); });

const GAP = 'GOV_MIG_DRY3_ROLLBACK_NOT_SIMULATED';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const reason = (err) => err.details.gaps.find((g) => g.code === GAP).detail.reason;
const go = async () => { await env.adminQuery('DELETE FROM governance.cutover_decisions WHERE company_id = $1', [A.companyId]); return env.decide(A, 'GO'); };
const refused = async (fields, pattern) => { reports.writeReport(A, fields); const err = await env.fail(go()); assert.equal(err && err.code, 'GOV_CUTOVER_NOT_READY'); assert.match(reason(err), pattern); };
const accepted = async (fields) => { reports.writeReport(A, fields); assert.ok((await go()).t0, 'GO aceito'); };
const withEnv = async (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  try { return await fn(); } finally { Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
};

test('m9d908 R4-L7: o commit é normalizado (minúsculas, SHA abreviado de 7 ou mais) e desconhecido nunca confere', () => {
  assert.equal(normalizeCommit(` ${SHA.toUpperCase()}\n`), SHA);
  assert.equal(normalizeCommit('unknown'), null);
  assert.equal(normalizeCommit('abc'), null);
  assert.ok(sameCommit(SHA.toUpperCase(), SHA));
  assert.ok(sameCommit(SHA.slice(0, 7), SHA));
  assert.ok(sameCommit(SHA, SHA.slice(0, 12)));
  assert.ok(!sameCommit(SHA.slice(0, 6), SHA), 'prefixo curto demais não vale');
  assert.ok(!sameCommit('deadbeef', SHA));
  assert.ok(!sameCommit('unknown', 'unknown'));
});

test('m9d908 R4-L7: árvore suja só se mede quando o commit vem do git; GIT_COMMIT, imagem e desconhecido contam como limpos', () => {
  assert.equal(treeDirty({ source: 'env' }), false);
  assert.equal(treeDirty({ source: 'image' }), false);
  assert.equal(treeDirty({ source: 'unknown' }), false);
  assert.equal(typeof treeDirty({ source: 'git' }), 'boolean');
});

test('m9d908 R4-L7: o relatório exportado carrega a marca de árvore suja dentro da assinatura', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d908x-'));
  return withEnv({ MIGRATION_DRY3_REPORT_PATH: path.join(dir, 'dry3-report.json'), MIGRATION_DRY3_SIGNING_KEY: reports.TEST_KEY, GIT_COMMIT: SHA }, () => {
    const { body } = exportReport({ id: 'e', conclusion: 'APROVADO', criteria: {} }, { companyId: '11111111-1111-4111-8111-111111111111' });
    assert.equal(body.dirty, false);
    const { verify } = require('../../../src/features/migration-v2/dryrun/dry.signature');
    assert.equal(verify(body).ok, true);
    assert.equal(verify({ ...body, dirty: true }).ok, false, 'editar a marca invalida a assinatura');
  });
});

test('m9d908 R4-L7: o GO aceita SHA abreviado ou em maiúsculas e recusa árvore suja (salvo exigência desligada)', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await withEnv({ GIT_COMMIT: SHA }, async () => {
      await accepted({ commit: SHA.slice(0, 10) });
      await accepted({ commit: SHA.toUpperCase() });
      await refused({ commit: SHA, dirty: true }, /alteração não commitada/);
      await env.setParam(A, 'migracao.dry3.exigir_commit_igual', false);
      await accepted({ commit: SHA, dirty: true });
    });
  } finally { s.dispose(); }
});

test('m9d908 R4-M2: contêiner sem .git e sem VERSION só alcança o GO com GIT_COMMIT; o relatório vem do volume apontado por MIGRATION_DRY3_REPORT_PATH', { skip: skip() }, async () => {
  const s = await env.scenario(A);
  try {
    await withEnv({ GIT_COMMIT: undefined, PATH: '' }, async () => {
      assert.equal(resolveCommit({ versionFile: '/nao/existe/VERSION' }).commit, 'unknown', 'sem .git, sem git e sem VERSION: desconhecido');
      await refused({ commit: SHA }, /outro commit/); // commit desconhecido nunca confere
    });
    await withEnv({ GIT_COMMIT: SHA, PATH: '' }, async () => {
      await accepted({ commit: SHA });
      assert.ok(process.env.MIGRATION_DRY3_REPORT_PATH.startsWith(os.tmpdir()) || process.env.MIGRATION_DRY3_REPORT_PATH.startsWith(fs.realpathSync(os.tmpdir())), 'relatório lido do caminho do volume, não de docs/governance');
    });
  } finally { s.dispose(); }
});

test('m9d908 R4-M2: o caminho oficial está documentado no .env.example e no README da migração', () => {
  const root = path.join(__dirname, '..', '..', '..');
  assert.match(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), /MIGRATION_DRY3_REPORT_PATH=/);
  assert.match(fs.readFileSync(path.join(root, 'src/features/migration-v2/README.md'), 'utf8'), /MIGRATION_DRY3_REPORT_PATH[\s\S]*GO[\s\S]*volume|volume[\s\S]*MIGRATION_DRY3_REPORT_PATH/);
});
