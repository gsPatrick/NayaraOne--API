'use strict';

// M9-D438 estágio 3 — migrations: as 15 tabelas do livro existem e todo o schema marketing tem RLS FORCE, política e GRANT ao nayara_runtime; tabela nova sem FORCE reprova o estágio; o CI só
// usa banco descartável. A parte com banco roda no banco descartável (DISPOSABLE_DB=1 + DATABASE_ADMIN_URL), sem skip: o teste falha se faltar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { problemasDasTabelasMarketing, TABELAS_DO_LIVRO } = require('../../../../scripts/marketing/ci/lib/migracoes');
const { RAIZ, estagiosDeBrinquedo, executar, lerEstagios } = require('../../_helpers/mktEsteira');

const ok = (tabela) => ({ tabela, rls: true, force_rls: true, politicas: 1, leitura_runtime: true });
const todas = () => TABELAS_DO_LIVRO.map(ok);

test('migrations_checam_rls_nas_15_tabelas: as 15 do livro (6 do núcleo e 9 da execução) estão na lista', () => {
  assert.equal(TABELAS_DO_LIVRO.length, 15);
  assert.equal(new Set(TABELAS_DO_LIVRO).size, 15);
});

test('migrations_checam_rls_nas_15_tabelas: sem FORCE, sem RLS, sem política, sem GRANT ou sem a tabela, o estágio acusa o problema com o nome da tabela', async () => {
  assert.deepEqual(await problemasDasTabelasMarketing(async () => todas()), []);
  const com = (nome, troca) => todas().map((t) => (t.tabela === nome ? { ...t, ...troca } : t));
  assert.deepEqual(await problemasDasTabelasMarketing(async () => com('campaigns', { force_rls: false })), ['marketing.campaigns: sem FORCE ROW LEVEL SECURITY']);
  assert.deepEqual(await problemasDasTabelasMarketing(async () => com('templates', { rls: false, force_rls: false })), ['marketing.templates: sem ROW LEVEL SECURITY', 'marketing.templates: sem FORCE ROW LEVEL SECURITY']);
  assert.deepEqual(await problemasDasTabelasMarketing(async () => com('review_requests', { politicas: 0 })), ['marketing.review_requests: sem nenhuma política RLS']);
  assert.deepEqual(await problemasDasTabelasMarketing(async () => com('attribution_events', { leitura_runtime: false })), ['marketing.attribution_events: sem GRANT de leitura ao nayara_runtime']);
  assert.deepEqual(await problemasDasTabelasMarketing(async () => todas().filter((t) => t.tabela !== 'suppression_list')), ['marketing.suppression_list: tabela do livro ausente']);
  assert.deepEqual(await problemasDasTabelasMarketing(async () => []), ['o schema marketing não tem nenhuma tabela: as migrations não foram aplicadas']);
  // tabela fora das 15 (criada por demanda seguinte) também é conferida
  assert.deepEqual(await problemasDasTabelasMarketing(async () => [...todas(), { ...ok('media_authorizations'), force_rls: false }]), ['marketing.media_authorizations: sem FORCE ROW LEVEL SECURITY']);
});

test('migrations_checam_rls_nas_15_tabelas: no banco descartável, as 15 passam e uma tabela nova sem FORCE reprova o estágio 3', async () => {
  assert.equal(process.env.DISPOSABLE_DB, '1', 'este teste exige banco descartável (scripts/withDisposableDb.js)');
  const url = process.env.DATABASE_ADMIN_URL;
  assert.ok(url && new URL(url).hostname === '127.0.0.1', 'DATABASE_ADMIN_URL em 127.0.0.1');
  const rodar = () => spawnSync('node', [path.join(RAIZ, 'scripts', 'marketing', 'ci', 'estagio3Migracoes.js'), '--so-verificar'], { cwd: RAIZ, encoding: 'utf8', env: process.env });
  const verde = rodar();
  assert.equal(verde.status, 0, verde.stderr);
  assert.match(verde.stdout, /tabelas marketing\.\* \(as 15 do livro incluídas\) com RLS FORCE, política e GRANT/);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('CREATE TABLE marketing.zz_ci_sem_force (id uuid PRIMARY KEY)');
    const vermelho = rodar();
    assert.equal(vermelho.status, 1);
    assert.match(vermelho.stderr, /REPROVADO/);
    assert.match(vermelho.stderr, /marketing\.zz_ci_sem_force: sem ROW LEVEL SECURITY/);
    assert.match(vermelho.stderr, /marketing\.zz_ci_sem_force: sem FORCE ROW LEVEL SECURITY/);
  } finally {
    await client.query('DROP TABLE IF EXISTS marketing.zz_ci_sem_force');
    await client.end();
  }
  assert.equal(rodar().status, 0, 'removida a tabela, o estágio volta a passar');
});

test('banco_do_ci_e_descartavel: estágio de banco recusa rodar fora do banco descartável e o script do CI só usa o cluster descartável', () => {
  const recusado = executar(estagiosDeBrinquedo({ 5: { banco: true } }));
  assert.equal(recusado.status, 1);
  assert.match(recusado.saida, /RECUSADO: estágio de banco só roda em banco descartável/);
  assert.deepEqual(recusado.marcas, [1, 2, 3, 4], 'o estágio 5 não executou comando nenhum');
  const liberado = executar(estagiosDeBrinquedo({ 5: { banco: true } }), [], { DISPOSABLE_DB: '1' });
  assert.equal(liberado.status, 0);
  const estagios = lerEstagios();
  for (const e of estagios.filter((x) => x.numero >= 4)) assert.equal(e.banco, true, `o estágio ${e.numero} (${e.nome}) roda em banco descartável`);
  const sh = fs.readFileSync(path.join(RAIZ, 'scripts', 'ci-estagios-marketing.sh'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'); // só o código, sem os comentários
  assert.match(sh, /node scripts\/withDisposableDb\.js --port/);
  assert.doesNotMatch(sh, /\.env\b|DATABASE_URL|DATABASE_ADMIN_URL/);
  const yml = fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'marketing-esteira.yml'), 'utf8');
  assert.doesNotMatch(yml, /DATABASE_URL|secrets\.(DB|DATABASE|POSTGRES)/i, 'o workflow não aponta para banco compartilhado');
  assert.doesNotMatch(yml, /deploy[-_ ]?prod|production[-_ ]?deploy/i);
  const estagio3 = fs.readFileSync(path.join(RAIZ, 'scripts', 'marketing', 'ci', 'estagio3Migracoes.js'), 'utf8');
  assert.match(estagio3, /127\.0\.0\.1/);
  assert.doesNotMatch(estagio3, /dotenv|\.env['"]/);
});
