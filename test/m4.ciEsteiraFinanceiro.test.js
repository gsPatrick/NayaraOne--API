'use strict';

// Marco 4, Guia do Marcelo §17 "CI/CD financeiro": a esteira tem os 17 estágios do livro com os nomes literais e na ordem (arquivo de estágios e workflow),
// para no primeiro vermelho, fica vermelha quando um teste exigido some, recusa estágio de banco fora do banco descartável e deixa o production_approval
// atrás da aprovação manual do environment "production", sem deploy. Sem banco: o runner roda estágios de brinquedo como processo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const E = require('../scripts/financeiro/ci/lib/estagios');

const RAIZ = path.join(__dirname, '..');
const EXECUTAR = path.join(RAIZ, 'scripts', 'financeiro', 'ci', 'executar.js');
const NOMES = ['lint', 'typecheck', 'unit_tests', 'db_migrations', 'finance_integration_tests', 'concurrency_tests', 'idempotency_tests', 'bank_adapter_contract_tests',
  'reconciliation_tests', 'closed_period_tests', 'multi_company_tests', 'security_scan', 'deploy_DEV', 'deploy_LAB', 'failure_drills', 'pentest', 'production_approval'];
const lerEstagios = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'financeiro', 'ci', 'estagios.json'), 'utf8')).estagios;
const workflow = () => yaml.load(fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'financeiro-esteira.yml'), 'utf8'));

const marcar = (numero, codigo = 0) => ['node', '-e', `require('fs').appendFileSync(process.env.M4CI_MARCA, '${numero}\\n'); process.exit(${codigo});`];
const brinquedo = (sobrescrever = {}) => E.ESTAGIOS_DO_LIVRO.map(([numero, nome]) => ({ numero, nome, tipo: E.TIPO_DO_LIVRO(numero), comandos: [marcar(numero)], ...(sobrescrever[numero] || {}) }));

function executar(estagios, args = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4ci-'));
  const arquivo = path.join(dir, 'estagios.json');
  const marca = path.join(dir, 'marca.txt');
  const relatorio = path.join(dir, 'relatorio.json');
  fs.writeFileSync(arquivo, JSON.stringify({ estagios }));
  fs.writeFileSync(marca, '');
  const r = spawnSync('node', [EXECUTAR, '--estagios', arquivo, '--relatorio', relatorio, ...args], { cwd: RAIZ, encoding: 'utf8', env: { ...process.env, M4CI_MARCA: marca, DISPOSABLE_DB: '', ...env } });
  const marcas = fs.readFileSync(marca, 'utf8').split('\n').filter(Boolean).map(Number);
  const rel = fs.existsSync(relatorio) ? JSON.parse(fs.readFileSync(relatorio, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, saida: `${r.stdout}${r.stderr}`, marcas, relatorio: rel };
}

test('M4-G§17 esteira financeira: os 17 estágios do Guia §17 com os nomes literais e na ordem do livro no estagios.json e no workflow', () => {
  const estagios = lerEstagios();
  assert.deepEqual(estagios.map((e) => e.nome), NOMES);
  assert.deepEqual(estagios.map((e) => e.numero), NOMES.map((_, i) => i + 1));
  assert.deepEqual(E.problemasDaDefinicao(estagios), []);
  const w = workflow();
  const passos = Object.values(w.jobs).flatMap((j) => j.steps || []).filter((s) => /^Estágio \d+: /.test(s.name || ''));
  const porNumero = passos.map((s) => [Number(/^Estágio (\d+):/.exec(s.name)[1]), s]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(porNumero.map(([, s]) => s.name), NOMES.map((nome, i) => `Estágio ${i + 1}: ${nome}`), 'o workflow lista os 17 estágios com os nomes do livro');
  for (const [n, s] of porNumero) assert.match(s.run, new RegExp(`scripts/ci-estagios-financeiro\\.sh .*--de ${n} --ate ${n}$`), `o passo do estágio ${n} roda só o estágio ${n}`);
  const push = w.jobs['esteira-financeiro'];
  assert.equal(push.if, undefined, 'os estágios 1 a 13, 15 e 16 rodam em todo push e pull request');
  assert.deepEqual(push.steps.filter((s) => /^Estágio/.test(s.name || '')).map((s) => Number(/\d+/.exec(s.name)[0])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]);
  assert.ok(w.on.pull_request !== undefined && w.on.push.branches.includes('entrega/**'));
  assert.match(w.jobs['entrega-financeiro'].if, /refs\/heads\/entrega\//);
  assert.equal(w.jobs['entrega-financeiro'].needs, 'esteira-financeiro');
  assert.match(w.jobs['entrega-financeiro'].steps.find((s) => /^Estágio 14/.test(s.name)).run, /--entrega/);
  assert.ok(fs.readFileSync(path.join(RAIZ, 'scripts', 'ci-estagios-financeiro.sh'), 'utf8').includes('scripts/financeiro/ci/executar.js'));
});

test('M4-G§17 esteira financeira: reordenar, renomear, faltar estágio, trocar o tipo ou tentar deploy de produção é recusado antes de rodar qualquer comando', () => {
  const estagios = lerEstagios();
  const trocados = [...estagios];
  [trocados[5], trocados[6]] = [trocados[6], trocados[5]];
  assert.ok(E.problemasDaDefinicao(trocados).length > 0, 'ordem trocada');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 8 ? { ...e, nome: 'bank tests' } : e))).length > 0, 'nome trocado');
  assert.ok(E.problemasDaDefinicao(estagios.slice(0, 16)).length > 0, 'estágio faltando');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 6 ? { ...e, tipo: 'entrega' } : e))).length > 0, 'estágio de push virando de entrega');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 17 ? { ...e, tipo: 'push' } : e))).length > 0, 'production_approval sem aprovação manual');
  assert.ok(E.problemasDaDefinicao(estagios.map((e) => (e.numero === 17 ? { ...e, comandos: [['npm', 'run', 'deploy-production']] } : e))).length > 0, 'deploy em produção');
  const r = executar(brinquedo().reverse());
  assert.equal(r.status, 2);
  assert.deepEqual(r.marcas, [], 'esteira inválida não roda comando nenhum');
});

test('M4-G§17 esteira financeira: estágio vermelho interrompe os seguintes e imprime FIN_CI_STAGE_FAILED', () => {
  const r = executar(brinquedo({ 4: { comandos: [marcar(4, 1)] } }));
  assert.equal(r.status, 1);
  assert.deepEqual(r.marcas, [1, 2, 3, 4], 'o 4 falhou: os seguintes não rodam');
  assert.match(r.saida, /FIN_CI_STAGE_FAILED Um estágio do pipeline financeiro falhou; a entrega está bloqueada\. \(estágio 4: db_migrations\)/);
  assert.deepEqual(r.relatorio.estagios.map((e) => e.status), ['VERDE', 'VERDE', 'VERDE', 'VERMELHO', ...Array(11).fill('NAO_RODOU')]);
  assert.equal(r.relatorio.resultado, 'VERMELHO');
});

test('M4-G§17 esteira financeira: push roda 1 a 13, 15 e 16; --entrega roda o 14; --aprovacao roda o 17; --todos roda os 17 em ordem', () => {
  assert.deepEqual(executar(brinquedo()).marcas, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]);
  assert.deepEqual(executar(brinquedo(), ['--entrega']).marcas, [14]);
  assert.deepEqual(executar(brinquedo(), ['--aprovacao']).marcas, [17]);
  const todos = executar(brinquedo(), ['--todos']);
  assert.equal(todos.status, 0);
  assert.deepEqual(todos.marcas, NOMES.map((_, i) => i + 1));
});

test('M4-G§17 esteira financeira: cada estágio tem comando e os testes exigidos existem de fato nos arquivos do estágio', () => {
  for (const e of lerEstagios()) {
    const comandos = E.comandosDaEtapa(e, RAIZ, { FIN_CI_PORTA_DRILL: '57000' });
    assert.ok(comandos.length > 0, `estágio ${e.numero} sem comando`);
    assert.deepEqual(E.testesExigidosAusentes(e), [], `estágio ${e.numero}: teste exigido ausente`);
    for (const c of comandos) if (c.argv[1] === '--test') for (const f of c.argv.filter((a) => a.startsWith('test/'))) assert.ok(fs.existsSync(path.join(RAIZ, f)), `${f} existe`);
  }
  const exigidos = lerEstagios().flatMap((e) => e.exigidos || []);
  for (const nome of ['ADV-F21 baixas parciais CONCORRENTES', 'FIN-004 idempotência', 'FIN-TS-007: importação de extrato em lote', 'contrato §11 scoreMatch', 'F02-C1b: mês fechado',
    'FIN-TS-020: financial_entries é isolado por EMPRESA', 'F06-PAY-05 resposta INCERTA', 'F06-IDOR-04']) assert.ok(exigidos.some((x) => x.startsWith(nome)), `${nome} é exigido por algum estágio`);
  const drill = lerEstagios().find((e) => e.numero === 15).comandos.find((c) => Array.isArray(c) && c.includes('scripts/restoreDrill/financeFullDrill.js'));
  assert.ok(drill, 'failure_drills roda o drill de restore/replay financeiro');
  assert.throws(() => E.comandosDaEtapa({ numero: 15, comandos: [drill] }, RAIZ, {}), /FIN_CI_PORTA_DRILL não definida/);
});

test('M4-G§17 esteira financeira: apagar um teste exigido (ADV-F21) reprova o estágio antes de rodar qualquer comando', () => {
  const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'm4ci-raiz-'));
  try {
    fs.mkdirSync(path.join(copia, 'test'));
    const original = fs.readFileSync(path.join(RAIZ, 'test', 'adversarial.finance.test.js'), 'utf8');
    fs.writeFileSync(path.join(copia, 'test', 'adversarial.finance.test.js'), original.replace(/ADV-F21[^'"`]*/g, 'teste renomeado'));
    const e6 = lerEstagios().find((e) => e.numero === 6);
    assert.ok(E.testesExigidosAusentes({ ...e6, comandos: [{ testes: ['test/adversarial.finance.test.js'] }] }, copia).includes('ADV-F21 baixas parciais CONCORRENTES'));
  } finally { fs.rmSync(copia, { recursive: true, force: true }); }
  const r = executar(brinquedo({ 6: { comandos: [{ testes: ['test/adversarial.finance.test.js'] }, marcar(6)], exigidos: ['teste-que-nao-existe-em-lugar-nenhum'] } }), ['--de', '6', '--ate', '6']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.marcas, [], 'nenhum comando do estágio rodou');
  assert.match(r.saida, /TESTE EXIGIDO AUSENTE: teste-que-nao-existe-em-lugar-nenhum/);
  assert.match(r.saida, /FIN_CI_STAGE_FAILED .*\(estágio 6: concurrency_tests\)/);
});

test('M4-G§17 esteira financeira: estágio de banco recusa rodar fora do banco descartável', () => {
  const r = executar(brinquedo({ 3: { banco: true } }), ['--de', '3', '--ate', '3']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.marcas, []);
  assert.match(r.saida, /RECUSADO: estágio de banco só roda em banco descartável/);
  const reais = lerEstagios().filter((e) => e.banco).map((e) => e.numero);
  for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16]) assert.ok(reais.includes(n), `estágio ${n} marcado como de banco`);
});

test('M4-G§17 esteira financeira: production_approval fica atrás do environment production com aprovação manual e nenhum passo publica produção', () => {
  const w = workflow();
  const job = w.jobs['aprovacao-producao-financeiro'];
  assert.equal(job.environment, 'production', 'o GitHub pausa o job até um revisor do environment production aprovar');
  assert.deepEqual(job.needs, ['esteira-financeiro', 'entrega-financeiro']);
  assert.match(job.steps.find((s) => /^Estágio 17/.test(s.name)).run, /--aprovacao/);
  for (const j of Object.values(w.jobs)) for (const s of j.steps || []) assert.doesNotMatch(`${s.run || ''}${JSON.stringify(s.env || {})}`, /PRODUCTION_API_DEPLOY_HOOK|deploy-production/);
  const r = spawnSync('node', ['scripts/financeiro/ci/aprovacaoProducao.js'], { cwd: RAIZ, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /portão conferido/);
  assert.match(r.stdout, /nenhuma aprovação foi dada nem registrada, nenhum deploy feito/);
});
