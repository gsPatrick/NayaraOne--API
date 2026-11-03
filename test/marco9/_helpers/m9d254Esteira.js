'use strict';

// Apoio dos testes da esteira de CI das integrações (M9-D254): etapas de brinquedo (cada uma escreve numa marca), execução do runner como processo e leitura do relatório.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const E = require('../../../scripts/int-ci/lib/estagios');

const RAIZ = path.join(__dirname, '..', '..', '..');
const EXECUTAR = path.join(RAIZ, 'scripts', 'int-ci', 'executar.js');

/** Comando de brinquedo: escreve o número da etapa na marca e sai com `codigo`. */
const marcar = (numero, codigo = 0) => ['node', '-e', `require('fs').appendFileSync(process.env.M9D254_MARCA, '${numero}\\n'); process.exit(${codigo});`];

/** As 13 etapas do livro com comandos de brinquedo (a 13 sem comando). `sobrescrever`: { [numero]: parteDaEtapa }. */
function etapasDeBrinquedo(sobrescrever = {}) {
  return E.ETAPAS_DO_LIVRO.map(([numero, nome]) => ({
    numero, nome, tipo: numero <= E.ULTIMA_DE_PR ? 'automatica' : 'release', comandos: numero === 13 ? [] : [marcar(numero)], ...(sobrescrever[numero] || {}),
  }));
}

/** Roda o runner com um arquivo de etapas de brinquedo. Devolve { status, saida, marcas (números que rodaram), relatorio }. */
function executar(etapas, args = [], env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d254-'));
  const arquivo = path.join(dir, 'etapas.json');
  const marca = path.join(dir, 'marca.txt');
  const relatorio = path.join(dir, 'relatorio.json');
  fs.writeFileSync(arquivo, JSON.stringify({ etapas }));
  fs.writeFileSync(marca, '');
  const r = spawnSync('node', [EXECUTAR, '--etapas', arquivo, '--relatorio', relatorio, ...args], { cwd: RAIZ, encoding: 'utf8', env: { ...process.env, M9D254_MARCA: marca, DISPOSABLE_DB: '', INT_CI_PASTA_RELATORIOS: path.join(dir, 'int-ci'), ...env } });
  const marcas = fs.readFileSync(marca, 'utf8').split('\n').filter(Boolean).map(Number);
  const rel = fs.existsSync(relatorio) ? JSON.parse(fs.readFileSync(relatorio, 'utf8')) : null;
  return { status: r.status, saida: `${r.stdout}${r.stderr}`, marcas, relatorio: rel };
}

const lerEtapas = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'int-ci', 'estagios.json'), 'utf8')).etapas;

module.exports = { RAIZ, marcar, etapasDeBrinquedo, executar, lerEtapas, E };
