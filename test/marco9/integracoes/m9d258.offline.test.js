'use strict';

// Marco 9, M9-D258 — a execução offline que sustenta a autochecagem: registro de conexões externas, JUnit das etapas e relatório consolidado (reports/offline-run.json).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const E = require('../../../scripts/int-ci/lib/estagios');
const { casosDoJunit } = require('../../../scripts/int-ci/lib/junit');
const { problemasOffline, nomeVerde, arquivosVerdes } = require('../../../scripts/int-autocheck/lib/relatorio');
const { arquivosDaSuite } = require('../../../scripts/int-autocheck/lib/ambienteSuite');

const RAIZ = path.join(__dirname, '..', '..', '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm9d258-off-'));

test('offline_guarda_registra_so_host_externo_sem_payload', () => {
  const dir = tmp();
  try {
    const log = path.join(dir, 'chamadas.log');
    const filho = path.join(dir, 'alvo.js');
    fs.writeFileSync(filho, `
      const net = require('node:net');
      const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1', () => {
        const porta = srv.address().port;
        net.connect(porta, '127.0.0.1').on('error', () => {}).destroy();
        net.connect({ port: porta, host: 'localhost' }).on('error', () => {}).destroy();
        net.connect({ path: '${path.join(dir, 'x.sock').replace(/\\/g, '/')}' }).on('error', () => {}).destroy();
        net.connect({ port: 9, host: '10.255.255.1' }).on('error', () => {}).destroy();
        net.connect(9, 'api.fornecedor-real.example').on('error', () => {}).destroy();
        srv.close();
      });`);
    const r = spawnSync('node', [`--require=${path.join(RAIZ, 'scripts/int-ci/offlineGuard.js')}`, filho], { encoding: 'utf8', env: { ...process.env, INT_OFFLINE_LOG: log } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), ['10.255.255.1', 'api.fornecedor-real.example']);
    // Sem INT_OFFLINE_LOG o arquivo não faz nada.
    const sem = spawnSync('node', [`--require=${path.join(RAIZ, 'scripts/int-ci/offlineGuard.js')}`, '-e', "require('node:net').connect(9,'10.255.255.1').on('error',()=>{}).destroy()"], { encoding: 'utf8', env: { ...process.env, INT_OFFLINE_LOG: '' } });
    assert.equal(sem.status, 0);
    assert.ok(net);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('offline_junit_e_relatorio_consolidado', () => {
  const dir = tmp();
  try {
    const entrada = path.join(dir, 'int-ci');
    fs.mkdirSync(entrada);
    const arq = (n) => path.join(RAIZ, 'test/marco9/integracoes', n);
    fs.writeFileSync(path.join(entrada, 'etapa-3-0.xml'), `<?xml version="1.0"?><testsuites>
      <testcase name="verde &quot;um&quot;" time="0.1" classname="test" file="${arq('a.test.js')}"/>
      <testcase name="pulado" time="0" classname="test" file="${arq('a.test.js')}"><skipped type="skipped" message="true"/></testcase>
      <testcase name="vermelho" time="0" classname="test" file="${arq('b.test.js')}"><failure type="testCodeFailure" message="x">detalhe</failure></testcase></testsuites>`);
    fs.writeFileSync(path.join(entrada, 'chamadas-externas.log'), '10.0.0.9\n10.0.0.9\n');
    const casos = casosDoJunit(fs.readFileSync(path.join(entrada, 'etapa-3-0.xml'), 'utf8'));
    assert.deepEqual(casos.map((c) => [c.nome, c.status]), [['verde "um"', 'pass'], ['pulado', 'skip'], ['vermelho', 'fail']]);
    const saida = path.join(dir, 'offline-run.json');
    const r = spawnSync('node', ['scripts/int-ci/offlineRelatorio.js', '--entrada', entrada, '--saida', saida], { cwd: RAIZ, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const rel = JSON.parse(fs.readFileSync(saida, 'utf8'));
    assert.deepEqual(rel.totais, { testes: 3, passaram: 1, falharam: 1, puladas: 1 });
    assert.equal(rel.chamadasExternas, 2);
    assert.deepEqual(Object.keys(rel.arquivos), ['test/marco9/integracoes/a.test.js', 'test/marco9/integracoes/b.test.js']);
    assert.ok(!JSON.stringify(rel).includes(RAIZ), 'o relatório não guarda caminho absoluto');
    // O verde é o do relatório: chamada externa, teste vermelho/pulado e arquivo da suíte que não rodou reprovam.
    const p = problemasOffline(rel, ['test/marco9/integracoes/a.test.js', 'test/marco9/integracoes/c.test.js']);
    assert.equal(p.length, 3);
    assert.match(p.join('|'), /2 chamada\(s\) externa\(s\).*2 teste\(s\) não verdes.*fora da execução offline/);
    assert.equal(nomeVerde(rel, 'pulado').ok, false);
    assert.equal(arquivosVerdes(rel, /a\.test\.js$/).ok, false);
    assert.deepEqual(problemasOffline({ chamadasExternas: 0, arquivos: { 'x.test.js': [['t', 'pass']] } }, ['x.test.js']), []);
    assert.equal(problemasOffline(null, [])[0].startsWith('relatório da execução offline ausente'), true);
    // Sem JUnit não há execução para relatar.
    const vazio = spawnSync('node', ['scripts/int-ci/offlineRelatorio.js', '--entrada', path.join(dir, 'nao-existe'), '--saida', saida], { cwd: RAIZ, encoding: 'utf8' });
    assert.equal(vazio.status, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('offline_etapas_de_teste_gravam_junit_e_carregam_a_guarda', () => {
  const etapas = E.carregar(path.join(RAIZ, 'scripts/int-ci/estagios.json'));
  const comandos = etapas.filter((e) => e.numero >= 3 && e.numero <= 9).flatMap((e) => E.comandosDaEtapa(e).filter((c) => c.argv[1] === '--test'));
  assert.ok(comandos.length >= 7);
  const destinos = new Set();
  for (const c of comandos) {
    assert.deepEqual(c.argv.slice(0, 2), ['node', '--test']);
    assert.ok(c.argv.includes('--test-reporter=junit') && c.argv.includes('--require=./scripts/int-ci/offlineGuard.js'));
    const xml = c.argv.find((a) => /^--test-reporter-destination=reports\/int-ci\/etapa-\d+-\d+\.xml$/.test(a));
    assert.ok(xml, 'um JUnit por comando');
    assert.ok(!destinos.has(xml), 'dois comandos não gravam o mesmo JUnit');
    destinos.add(xml);
    assert.equal(c.env.INT_OFFLINE_LOG, 'reports/int-ci/chamadas-externas.log');
  }
  const e9 = etapas.find((e) => e.numero === 9).comandos.filter(Array.isArray).map((c) => c.join(' '));
  assert.ok(e9.indexOf('node scripts/int-ci/offlineRelatorio.js') >= 0 && e9.indexOf('node scripts/int-ci/offlineRelatorio.js') < e9.indexOf('node scripts/integrationDod.js'), 'o relatório é consolidado antes do DoD');
  // A suíte que a autochecagem exige no relatório é a mesma que a esteira roda (fonte única: estagios.json).
  const esperados = arquivosDaSuite('integracoes', RAIZ);
  assert.ok(esperados.includes('test/marco9/integracoes/m9d211.canal.test.js') && esperados.every((a) => a.endsWith('.test.js') && fs.existsSync(path.join(RAIZ, a))));
  assert.ok(arquivosDaSuite('ia-nay', RAIZ).every((a) => a.startsWith('test/marco9/ia/')));
});
