'use strict';

/**
 * Guia do Marco 6, §13 (CI/CD de Obras): a esteira tem as 17 etapas com os nomes literais do livro, nesta ordem; toda etapa de
 * teste aponta para arquivos que existem; nenhum teste de Obras fica fora da esteira; só LAB depende de release; o workflow roda a
 * esteira sem continue-on-error nem if: false; security scan, concorrência, carga/falha e o drill de restore estão nas etapas certas;
 * os limites de carga vêm do arquivo de parâmetros (todos usados, todos explicados); os arquivos novos têm no máximo 400 linhas.
 * Teste estático (não precisa de banco).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ETAPAS, NOMES_DO_LIVRO, ARQUIVOS_DA_ESTEIRA, validar } = require('../scripts/ci-obras/etapas');

const ROOT = path.resolve(__dirname, '..');
const LIVRO = 'lint → typecheck → migrations → baseline tests → dependency tests → daily-log tests → measurement idempotency → finance-event tests → inventory integration → quality gate → warranty SLA → multi-company → concurrency → security scan → DEV → LAB → load/failure tests';
const etapa = (nome) => ETAPAS.find((e) => e.nome === nome);
const argumentos = (e) => e.comandos.flat();

test('Guia M6 §13: as 17 etapas com os nomes literais do livro, na ordem; outra ordem é recusada', () => {
  assert.deepEqual(NOMES_DO_LIVRO, LIVRO.split(' → '));
  assert.deepEqual(ETAPAS.map((e) => e.nome), NOMES_DO_LIVRO);
  assert.equal(validar(), true);
  assert.throws(() => validar([...ETAPAS].reverse()), /CONSTRUCTION_CI_STAGES_MISMATCH/);
  assert.throws(() => validar(ETAPAS.slice(1)), /CONSTRUCTION_CI_STAGES_MISMATCH/);
});

test('Guia M6 §13: todo arquivo de teste citado existe e todo test/construction.*.test.js está em alguma etapa', () => {
  const citados = new Set(ETAPAS.flatMap((e) => argumentos(e).filter((a) => /^test\/.+\.test\.js$/.test(a))));
  for (const a of citados) assert.ok(fs.existsSync(path.join(ROOT, a)), `${a} não existe`);
  const deObras = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /^construction\..+\.test\.js$/.test(f)).map((f) => `test/${f}`);
  assert.deepEqual(deObras.filter((f) => !citados.has(f)), [], 'teste de Obras fora da esteira');
});

test('Guia M6 §13: só LAB é de release; nenhuma etapa sem comando; etapas de banco rodam só no descartável', () => {
  assert.deepEqual(ETAPAS.filter((e) => e.release).map((e) => e.nome), ['LAB']);
  for (const e of ETAPAS) assert.ok(e.comandos.length > 0, `${e.nome} sem comando`);
  for (const nome of NOMES_DO_LIVRO.slice(2)) if (nome !== 'LAB') assert.equal(etapa(nome).banco, true, `${nome} precisa de banco descartável`);
  assert.doesNotMatch(JSON.stringify(ETAPAS), /deploy[-_ ]?(prod|production)|production[-_ ]?deploy|--prod\b/i, 'a esteira nunca faz deploy em produção');
});

test('Caderno §14 / Guia §13: security scan com as varreduras do projeto e os testes adversariais; concorrência, carga, falha e restore nas etapas do livro', () => {
  const scan = argumentos(etapa('security scan'));
  for (const item of ['scripts/secretScan.js', 'scripts/dependencyAudit.js', 'scripts/sastScan.js', 'scripts/checkNaoImprovisar.js', 'scripts/scanConstructionHardcode.js', 'test/construction.adversarialHttp.test.js']) {
    assert.ok(scan.includes(item), `security scan sem ${item}`);
  }
  assert.ok(argumentos(etapa('concurrency')).includes('test/construction.concorrencia.test.js'));
  const carga = argumentos(etapa('load/failure tests'));
  for (const item of ['test/construction.carga.test.js', 'test/construction.falhas.test.js', 'test/construction.failureDrills.test.js', 'scripts/restoreDrill/constructionFullDrill.js']) {
    assert.ok(carga.includes(item), `load/failure tests sem ${item}`);
  }
});

test('Guia M6 §13: o workflow roda a esteira de Obras sem continue-on-error nem if: false; LAB só em tag obr-release-*', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'obras-esteira.yml'), 'utf8');
  assert.doesNotMatch(yml, /continue-on-error/);
  assert.doesNotMatch(yml, /if:\s*false/);
  assert.match(yml, /scripts\/ci-estagios-obras\.sh/);
  assert.match(yml, /obr-release-\*/);
  assert.match(yml, /reports\/obras-ci/);
});

test('Sprint O9: limites de carga só no arquivo de parâmetros — todos positivos, explicados e usados pelos testes', () => {
  const { parametros } = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ci-obras', 'parametros.json'), 'utf8'));
  const fontes = ['test/construction.carga.test.js', 'test/construction.concorrencia.test.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  for (const [nome, p] of Object.entries(parametros)) {
    assert.ok(Number.isFinite(p.valor) && p.valor > 0, `${nome} precisa ser positivo`);
    assert.ok(p.explicacao && p.explicacao.length > 20, `${nome} sem explicação`);
    assert.ok(fontes.includes(`P.${nome}`), `${nome} não é usado por nenhum teste`);
  }
  assert.equal(parametros.limiteP95LeituraMs.valor, 300, 'contrato §16: p95 < 300ms em consultas comuns');
});

test('Sem god file: os arquivos da esteira de Obras têm no máximo 400 linhas', () => {
  const arquivos = ARQUIVOS_DA_ESTEIRA.flatMap((a) => {
    const abs = path.join(ROOT, a);
    return fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).filter((f) => f.endsWith('.js')).map((f) => path.join(abs, f)) : [abs];
  });
  const grandes = arquivos.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, 'utf8').split('\n').length]).filter(([, n]) => n > 400);
  assert.deepEqual(grandes, []);
});

test('Executor comum das esteiras: opções na primeira posição valem (--relatorio, --de) e os marcadores de porta são trocados', () => {
  const { argumento, trocarMarcadores, resolverPortas } = require('../scripts/lib/esteiraLivro');
  assert.equal(argumento(['--relatorio', 'r.json', '--de', '3'], '--relatorio'), 'r.json');
  assert.equal(argumento(['--de', '13', '--ate', '15'], '--de'), '13');
  assert.equal(argumento(['--release'], '--de'), null);
  const portas = resolverPortas({ portaHttp: { env: 'X_PORTA_TESTE', base: 45000, faixa: 1000 } }, { X_PORTA_TESTE: '45123' });
  assert.deepEqual(trocarMarcadores(['--port', '{portaHttp}', '{outro}'], portas), ['--port', '45123', '{outro}']);
});
