'use strict';

// M9-D044 — estágios 3 (migrations) e 13 a 16 (portões de ambiente) da esteira da NAY: tabela ai.* sem RLS reprova e os portões DEV, LAB,
// red-team e production approval só abrem com registro humano aprovado em ai.release_gates. Os testes de banco rodam no cluster descartável.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { SKIP, DISPOSABLE } = require('../_helpers/aiHttpEnv');
const H = require('../_helpers/iaEsteira');
const { problemasDasTabelasAi } = require('../../../scripts/ai-ci/lib/migracoes');
const P = require('../../../scripts/ai-ci/lib/portoes');

const VERIFICAR = path.join(H.API, 'scripts', 'ai-ci', 'estagio3Migracoes.js');
const verificar = () => spawnSync(process.execPath, [VERIFICAR, '--so-verificar'], { cwd: H.API, encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL } });

async function comoAdmin(fn) {
  const c = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  try { return await fn((sql, params) => c.query(sql, params)); } finally { await c.end(); }
}

test('m9d044_estagio_3_reprova_tabela_ai_sem_rls', () => {
  // lógica pura: cada defeito vira um problema nomeado
  const linha = (o) => ({ tabela: 't', rls: true, force_rls: true, politicas: 1, leitura_runtime: true, ...o });
  const run = (linhas) => problemasDasTabelasAi(async () => linhas);
  return Promise.all([
    run([linha({})]).then((p) => assert.deepEqual(p, [])),
    run([linha({ rls: false, force_rls: false, politicas: 0 })]).then((p) => assert.equal(p.length, 3, p.join('|'))),
    run([linha({ force_rls: false })]).then((p) => assert.match(p[0], /ai\.t: sem FORCE ROW LEVEL SECURITY/)),
    run([linha({ leitura_runtime: false })]).then((p) => assert.match(p[0], /sem GRANT de leitura/)),
    run([]).then((p) => assert.match(p[0], /nenhuma tabela/)),
  ]);
});

test('m9d044_estagio_3_banco_real_reprova_e_aprova', { skip: SKIP }, async () => {
  assert.ok(DISPOSABLE);
  const ok = verificar();
  assert.equal(ok.status, 0, `schema ai atual deve passar:\n${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /tabelas ai\.\* com RLS FORCE, política e GRANT/);
  await comoAdmin(async (q) => {
    await q('CREATE TABLE ai.tmp_d044_sem_rls (id uuid PRIMARY KEY, company_id uuid)');
    await q('REVOKE ALL ON ai.tmp_d044_sem_rls FROM nayara_runtime'); // o cluster pode dar GRANT por privilégio padrão; aqui a tabela nasce sem ele
  });
  try {
    const sem = verificar();
    assert.equal(sem.status, 1, 'tabela ai.* sem RLS reprova o estágio');
    assert.match(sem.stderr, /ai\.tmp_d044_sem_rls: sem ROW LEVEL SECURITY/);
    assert.match(sem.stderr, /sem nenhuma política RLS/);
    await comoAdmin((q) => q('ALTER TABLE ai.tmp_d044_sem_rls ENABLE ROW LEVEL SECURITY'));
    const semForce = verificar();
    assert.equal(semForce.status, 1);
    assert.match(semForce.stderr, /sem FORCE ROW LEVEL SECURITY/);
    await comoAdmin(async (q) => {
      await q('ALTER TABLE ai.tmp_d044_sem_rls FORCE ROW LEVEL SECURITY');
      await q('CREATE POLICY tenant_isolation ON ai.tmp_d044_sem_rls USING (company_id::text = current_setting(\'app.company_id\', true))');
    });
    const semGrant = verificar();
    assert.equal(semGrant.status, 1, 'sem GRANT ao nayara_runtime também reprova');
    assert.match(semGrant.stderr, /sem GRANT de leitura ao nayara_runtime/);
    await comoAdmin((q) => q('GRANT SELECT, INSERT, UPDATE, DELETE ON ai.tmp_d044_sem_rls TO nayara_runtime'));
    assert.equal(verificar().status, 0, 'com RLS FORCE, política e GRANT passa');
  } finally {
    await comoAdmin((q) => q('DROP TABLE IF EXISTS ai.tmp_d044_sem_rls'));
  }
});

test('m9d044_portoes_13_a_16_exigem_registro', async () => {
  assert.deepEqual(P.ITENS, { 13: 'DEV_DEPLOY', 14: 'LAB_VALIDATION', 15: 'RED_TEAM', 16: 'PRODUCTION_APPROVAL' });
  const real = H.lerReal().estagios;
  for (const [n, item] of Object.entries(P.ITENS)) {
    assert.equal(real[n - 1].item, item);
    assert.equal(real[n - 1].tipo, 'registro');
    const semConexao = await P.verificarPortao(null, item);
    assert.equal(semConexao.ok, false);
    assert.match(semConexao.motivo, new RegExp(`sem registro de ${item}`));
    const vazio = await P.verificarPortao(async () => [], item);
    assert.equal(vazio.ok, false, 'sem linha APPROVED não abre');
    const semTabela = await P.verificarPortao(async () => { throw Object.assign(new Error('x'), { code: '42P01' }); }, item);
    assert.match(semTabela.motivo, /ai\.release_gates não existe/);
    const aprovado = await P.verificarPortao(async (sql, params) => {
      assert.match(sql, /status = 'APPROVED'/);
      assert.match(sql, /approved_by IS NOT NULL/);
      assert.deepEqual(params, [item]);
      return [{ id: 'g1', evidence_ref: 'rel-1', approved_by: 'u', approved_at: new Date() }];
    }, item);
    assert.equal(aprovado.ok, true);
  }
  const semEvidencia = await P.verificarPortao(async () => [{ id: 'g', evidence_ref: ' ', approved_by: 'u', approved_at: new Date() }], 'LAB_VALIDATION', { exigeEvidencia: true });
  assert.equal(semEvidencia.ok, false);
  assert.match(semEvidencia.motivo, /não cita a evidência/);

  // a esteira real: sem registro, o estágio 13 fica vermelho e os demais nem rodam; nada é pulado
  const r = H.executar(H.esteiraFalsa(), ['--de', '13'], {});
  assert.equal(r.status, 1);
  assert.deepEqual(r.relatorio.estagios.map((x) => [x.numero, x.status]), [[13, 'VERMELHO'], [14, 'NAO_RODOU'], [15, 'NAO_RODOU'], [16, 'NAO_RODOU']]);
  assert.match(r.log, /SEM REGISTRO: sem registro de DEV_DEPLOY/);
  assert.doesNotMatch(r.saida, /postgres:\/\//);
});

test('m9d044_portoes_leem_o_registro_aprovado_no_banco', { skip: SKIP }, async () => {
  const tabela = 'ai.tmp_d044_release_gates';
  await comoAdmin((q) => q(`CREATE TABLE ${tabela} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_type text, item text, status text, evidence_ref text, approved_by uuid, approved_at timestamptz)`));
  try {
    const consulta = async (sql, params) => comoAdmin(async (q) => (await q(sql.replace('ai.release_gates', tabela), params)).rows);
    const ator = (await comoAdmin((q) => q('SELECT id FROM core.users ORDER BY email LIMIT 1'))).rows[0].id;
    const abre = async (item, o) => (await P.verificarPortao(consulta, item, o)).ok;
    for (const item of Object.values(P.ITENS)) assert.equal(await abre(item), false, `${item} sem linha`);
    await comoAdmin((q) => q(`INSERT INTO ${tabela} (scope_type, item, status) VALUES ('GLOBAL', 'DEV_DEPLOY', 'PENDING'), ('AGENT', 'RED_TEAM', 'APPROVED')`));
    assert.equal(await abre('DEV_DEPLOY'), false, 'PENDING não abre');
    assert.equal(await abre('RED_TEAM'), false, 'escopo que não é GLOBAL não abre');
    await comoAdmin((q) => q(`INSERT INTO ${tabela} (scope_type, item, status, approved_by, approved_at) VALUES ('GLOBAL', 'DEV_DEPLOY', 'APPROVED', NULL, now())`));
    assert.equal(await abre('DEV_DEPLOY'), false, 'aprovação sem quem aprovou não abre');
    await comoAdmin((q) => q(`INSERT INTO ${tabela} (scope_type, item, status, approved_by, approved_at, evidence_ref) VALUES ('GLOBAL', 'DEV_DEPLOY', 'APPROVED', $1, now(), 'deploy-1'), ('GLOBAL', 'LAB_VALIDATION', 'APPROVED', $1, now(), NULL)`, [ator]));
    assert.equal(await abre('DEV_DEPLOY'), true);
    assert.equal(await abre('LAB_VALIDATION'), true);
    assert.equal(await abre('LAB_VALIDATION', { exigeEvidencia: true }), false, 'LAB sem evidência não abre');
    assert.equal(await abre('RED_TEAM'), false);
    assert.equal(await abre('PRODUCTION_APPROVAL'), false);
  } finally {
    await comoAdmin((q) => q(`DROP TABLE IF EXISTS ${tabela}`));
  }
});
