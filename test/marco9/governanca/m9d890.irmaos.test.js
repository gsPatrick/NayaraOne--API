'use strict';

// M9-D890: o CI só tem a API. O que depende de Maturacao/ ou do Front EXIGE o artefato (falha se ausente) e só vira NAO_APLICAVEL_NO_CI (dito, nunca "passou") quando o workflow
// declara CI_SEM_REPOS_IRMAOS=1. Estes testes provam as duas pontas com processos filhos e pastas temporárias, sem tocar nos repositórios irmãos de verdade.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { spawnSync } = require('node:child_process');

const RAIZ = path.join(__dirname, '..', '..', '..');
const HELPER = path.join(RAIZ, 'test', 'helpers', 'repoIrmao.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm9d890-irm-'));
const node = (args, env = {}, opts = {}) => spawnSync(process.execPath, args, { cwd: RAIZ, encoding: 'utf8', env: { ...process.env, CI_SEM_REPOS_IRMAOS: '', ...env }, ...opts });

test('m9d890 irmaos: sem a variável o artefato ausente continua exigido; com a variável vira NAO_APLICAVEL_NO_CI; presente roda mesmo com a variável', () => {
  const script = `const h=require(${JSON.stringify(HELPER)}); console.log(JSON.stringify([h.motivoNaoAplicavel(['Maturacao/nao-existe.csv']), h.motivoNaoAplicavel([path.relative(path.join(${JSON.stringify(RAIZ)},'..'), ${JSON.stringify(RAIZ)}).split(path.sep).join('/')+'/package.json'])]))`.replace(/^/, 'const path=require("node:path");');
  const sem = JSON.parse(node(['-e', script]).stdout);
  assert.deepEqual(sem, [false, false], 'sem a variável nada é dispensado: o teste roda e falha por ENOENT');
  const com = JSON.parse(node(['-e', script], { CI_SEM_REPOS_IRMAOS: '1' }).stdout);
  assert.match(com[0], /^NAO_APLICAVEL_NO_CI: Maturacao\/nao-existe\.csv ausente no CI .*coberto na suíte local/);
  assert.equal(com[1], false, 'com o artefato presente o teste roda inteiro');
  assert.equal(node(['-e', script], { CI_SEM_REPOS_IRMAOS: 'true' }).stdout.includes('NAO_APLICAVEL'), false, 'só o valor 1 vale');
});

test('m9d890 irmaos: o JUnit com pulo NAO_APLICAVEL_NO_CI só passa com a variável e o pulo comum sempre reprova', () => {
  const dir = tmp();
  const na = path.join(dir, 'na.xml');
  fs.writeFileSync(na, '<testsuites><testcase name="a"/><testcase name="b"><skipped type="skipped" message="NAO_APLICAVEL_NO_CI: x ausente"/></testcase></testsuites>');
  const comum = path.join(dir, 'comum.xml');
  fs.writeFileSync(comum, '<testsuites><testcase name="a"/><testcase name="b"><skipped type="skipped" message="motivo qualquer"/></testcase></testsuites>');
  const check = (f, env) => node([path.join(RAIZ, 'scripts', 'governance-ci', 'checkJunit.js'), f], env);
  const sem = check(na, {});
  assert.equal(sem.status, 1, 'sem a declaração do workflow o pulo reprova');
  assert.match(sem.stderr, /GOV_CI_TEST_SKIPPED/);
  const com = check(na, { CI_SEM_REPOS_IRMAOS: '1' });
  assert.equal(com.status, 0);
  assert.match(com.stdout, /NAO_APLICAVEL_NO_CI \(nao passou, nao foi executado\): b/);
  assert.match(com.stdout, /1 NAO APLICAVEIS NO CI/);
  assert.equal(check(comum, { CI_SEM_REPOS_IRMAOS: '1' }).status, 1, 'pulo sem o marcador reprova mesmo com a variável');
});

test('m9d890 irmaos: o mapa adversarial dispensa só o nome que mora no Front, só com a variável, e diz que não verificou', () => {
  const dir = tmp();
  const teste = path.join(dir, 'test');
  fs.mkdirSync(teste);
  const itens = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, demanda: `M9-D${i}`, testes: [`m9d890 irm item ${i + 1}`] }));
  const mapa = path.join(dir, 'mapa.json');
  fs.writeFileSync(mapa, JSON.stringify({ raizes: [teste, path.join(dir, '..', 'front-que-nao-existe-m9d890', 'test')].map((p) => path.relative(RAIZ, p)), nomes_no_front: ['m9d890 irm item 8'], itens }));
  const sem = itens.filter((i) => i.n !== 8).map((i) => `test('${i.testes[0]}', () => {});`).join('\n');
  fs.writeFileSync(path.join(teste, 'a.test.js'), sem);
  const cli = (env) => node([path.join(RAIZ, 'scripts', 'checkAdversarialMap.js'), '--mapa', mapa], env);
  const estrito = cli({});
  assert.equal(estrito.status, 2, 'sem a variável a raiz ausente do Front continua erro de leitura');
  const ci = cli({ CI_SEM_REPOS_IRMAOS: '1' });
  assert.equal(ci.status, 0, ci.stderr);
  assert.match(ci.stdout, /9 de 10 nomes presentes e ativos, 0 ausentes, 0 problemas no mapa, 1 NAO_APLICAVEL_NO_CI \(nao verificado\)/);
  assert.match(ci.stdout, /NAO_APLICAVEL_NO_CI: m9d890 irm item 8 .*coberto na suíte local/);
  fs.writeFileSync(path.join(teste, 'a.test.js'), sem.replace("test('m9d890 irm item 3'", "test('outro nome'"));
  const faltaNaApi = cli({ CI_SEM_REPOS_IRMAOS: '1' });
  assert.equal(faltaNaApi.status, 1, 'o nome que devia estar na API continua exigido no CI');
  assert.match(faltaNaApi.stderr, /GOV_ADVERSARIAL_MISSING: .*m9d890 irm item 3/);
});

test('m9d890 irmaos: os workflows declaram a ausência e a governança prepara o Front sem exigir segredo', () => {
  const wf = (n) => yaml.load(fs.readFileSync(path.join(RAIZ, '.github', 'workflows', n), 'utf8'));
  for (const [arq, jobs] of [['marketing-esteira.yml', ['esteira-marketing', 'entrega-marketing']], ['integracoes-esteira.yml', ['esteira-integracoes', 'release-lab']]]) {
    for (const j of jobs) assert.equal(wf(arq).jobs[j].env.CI_SEM_REPOS_IRMAOS, '1', `${arq}/${j} declara CI_SEM_REPOS_IRMAOS`);
  }
  const gov = wf('governanca.yml');
  for (const j of ['dlp', 'accessibility', 'adversarial-map']) {
    assert.ok(gov.jobs[j].steps.some((s) => /prepararFront\.sh/.test(s.run || '')), `${j} prepara o Front ou declara a ausência`);
    assert.ok(!gov.jobs[j].env.CI_SEM_REPOS_IRMAOS, `${j}: a declaração vem do script, só quando o Front realmente falta`);
  }
  const prep = fs.readFileSync(path.join(RAIZ, 'scripts', 'governance-ci', 'prepararFront.sh'), 'utf8');
  assert.match(prep, /CI_SEM_REPOS_IRMAOS=1" >> "\$GITHUB_ENV"/);
  assert.match(prep, /::warning/);
  assert.doesNotMatch(prep, /secrets\./);
});
