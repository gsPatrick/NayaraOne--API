'use strict';

/**
 * Execução offline da suíte da NAY (M9-D047, critério herdado da M9-D258): quais arquivos de teste entram e o comando que os roda com JUnit e com o registro de
 * conexões externas. Entram TODOS os de test/marco9/ia/ e os que provam os itens do DoD e ficam fora dessa pasta (ex.: test/ai/m9d004.servico.test.js, m9d005).
 */
const fs = require('node:fs');
const path = require('node:path');
const { arquivosDaPasta } = require('../../int-autocheck/lib/ambienteSuite');
const { nomesDeclarados } = require('../../int-ci/lib/adversarial');
const { casaComNome } = require('../../ai-dod/lib/avaliar');

const PASTA_JUNIT = 'reports/ai-ci';
const GUARDA = 'scripts/int-ci/offlineGuard.js';
const RELATORIO = 'reports/offline-run-ia.json';

/** Arquivos de teste de fora de test/marco9/ia/ que declaram uma prova da matriz do DoD. */
function arquivosDaMatriz(raiz, matriz) {
  const provas = matriz.itens.flatMap((it) => it.provas.map((p) => p.teste));
  return arquivosDaPasta(path.join(raiz, 'test'), raiz)
    .filter((a) => !a.startsWith('test/marco9/ia/'))
    .filter((a) => [...nomesDeclarados(fs.readFileSync(path.join(raiz, a), 'utf8'))].some((n) => provas.some((p) => casaComNome(n, p))));
}

/** Toda a suíte da IA mais os arquivos da matriz, em ordem alfabética, sem repetir. */
function arquivosDaExecucao(raiz, matriz) {
  return [...new Set([...arquivosDaPasta(path.join(raiz, 'test/marco9/ia'), raiz), ...arquivosDaMatriz(raiz, matriz)])].sort();
}

/** Comando e ambiente do `node --test` da execução (JUnit e guarda de conexões externas, como nas integrações). */
function comandoDaExecucao(arquivos) {
  return {
    argv: ['node', '--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${PASTA_JUNIT}/suite-ia.xml`, `--require=./${GUARDA}`, ...arquivos],
    env: { NODE_ENV: 'test', INT_OFFLINE_LOG: `${PASTA_JUNIT}/chamadas-externas.log` },
  };
}

/** Comando que consolida os JUnit em reports/offline-run-ia.json (o mesmo consolidador da M9-D258, escopo ia-nay). */
const comandoDoRelatorio = () => ['node', 'scripts/int-ci/offlineRelatorio.js', '--escopo', 'ia-nay', '--entrada', PASTA_JUNIT, '--saida', RELATORIO];

module.exports = { arquivosDaMatriz, arquivosDaExecucao, comandoDaExecucao, comandoDoRelatorio, PASTA_JUNIT, RELATORIO };
