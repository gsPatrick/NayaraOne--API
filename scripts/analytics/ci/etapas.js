'use strict';

/**
 * M9-D705 (Guia §12) — as 14 etapas do CI/CD do BI, na ordem do livro. Cada etapa é uma lista de comandos; o primeiro que falha reprova a
 * etapa e a seguinte não roda. `banco: true` marca o comando que escreve no banco: só roda em banco descartável (127.0.0.1), nunca na
 * homologação. As etapas 1 a 11 rodam em todo pull request (fase `pr`); 12 a 14, na promoção (fase `promocao`).
 * A suíte adversarial (M9-D704) roda dentro das etapas 5, 7, 9, 10 e 11 por padrão de nome, e juntas cobrem os 15 nomes.
 */
const ADV = 'test/marco9/analytics/m9d704.adversarial.test.js';
const A = 'test/marco9/analytics';

const node = (...args) => ({ cmd: 'node', args, banco: false });
const teste = (...arquivos) => ({ cmd: 'node', args: ['--test', '--test-concurrency=1', ...arquivos], banco: true });
const adversarial = (numeros) => ({ cmd: 'node', args: ['--test', '--test-concurrency=1', '--test-name-pattern', `adv(${numeros.join('|')}) `, ADV], banco: true });

const ETAPAS = [
  { n: 1, chave: 'lint', livro: 'lint', fase: 'pr', comandos: [{ cmd: 'npm', args: ['run', 'lint'], banco: false }] },
  { n: 2, chave: 'typecheck', livro: 'typecheck', fase: 'pr', comandos: [{ cmd: 'npm', args: ['run', 'syntax-check'], banco: false }, node('scripts/analytics/ci/typecheckFront.js')] },
  { n: 3, chave: 'migrations', livro: 'migrations', fase: 'pr', comandos: [{ cmd: 'node', args: ['scripts/analytics/ci/migracoesCiclo.js'], banco: true }] },
  { n: 4, chave: 'metric-formula-tests', livro: 'metric formula tests', fase: 'pr', comandos: [
    node('scripts/analytics/checkFormulaTests.js'),
    { cmd: 'node', args: ['--test', 'test/analytics/formulas/*.test.js'], banco: false },
    teste(`${A}/m9d614.banco.test.js`, `${A}/m9d614.estaticos.test.js`, 'test/analytics.m9d603.test.js', 'test/analytics.m9d603.read.test.js')] },
  { n: 5, chave: 'read-model-idempotency', livro: 'read model idempotency', fase: 'pr', comandos: [
    teste(`${A}/m9d607.*.test.js`, `${A}/*.replay.test.js`), adversarial(['01', '04', '05', '13', '14', '15'])] },
  { n: 6, chave: 'reconciliation-tests', livro: 'reconciliation tests', fase: 'pr', comandos: [teste(`${A}/m9d611.*.test.js`, `${A}/m9d696.*.test.js`)] },
  { n: 7, chave: 'rls', livro: 'RLS', fase: 'pr', comandos: [
    teste('test/rls.catalog.allTables.test.js', 'test/analytics.m9d600.isolamento.test.js', `${A}/m9d700.*.test.js`, `${A}/m9d690.*.test.js`, `${A}/*.isolamento.test.js`),
    adversarial(['02', '07', '11'])] },
  { n: 8, chave: 'quality-checks', livro: 'quality checks', fase: 'pr', comandos: [
    teste(`${A}/m9d696.*.test.js`, `${A}/m9d697.*.test.js`), { cmd: 'node', args: ['scripts/analytics/ci/gateQualidade.js'], banco: true }] },
  { n: 9, chave: 'alert-dedup', livro: 'alert dedup', fase: 'pr', comandos: [teste(`${A}/m9d691.*.test.js`, `${A}/m9d609.alerta.test.js`), adversarial(['03', '06', '10'])] },
  { n: 10, chave: 'export-security', livro: 'export security', fase: 'pr', comandos: [teste(`${A}/m9d701.*.test.js`, `${A}/m9d700.mascaramento.test.js`), adversarial(['08', '09'])] },
  { n: 11, chave: 'load-rebuild', livro: 'load/rebuild', fase: 'pr', comandos: [teste(`${A}/m9d699.*.test.js`, `${A}/m9d608.*.test.js`), adversarial(['12'])] },
  { n: 12, chave: 'dev', livro: 'DEV', fase: 'promocao', comandos: [node('scripts/analytics/ci/smokeDev.js')] },
  { n: 13, chave: 'lab', livro: 'LAB', fase: 'promocao', comandos: [
    { cmd: 'node', args: ['scripts/analytics/loadTest.js', '--scale', 'full', '--rounds', '3'], banco: true }, teste(`${A}/m9d699.rebuild.test.js`, `${A}/m9d608.reproducao.test.js`)] },
  { n: 14, chave: 'owner-reconciliation', livro: 'owner reconciliation', fase: 'promocao', comandos: [{ cmd: 'node', args: ['scripts/analytics/ci/gateAceite.js'], banco: true }] },
];

const NOMES_DO_LIVRO = ETAPAS.map((e) => e.livro);

module.exports = { ETAPAS, NOMES_DO_LIVRO };
