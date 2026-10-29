'use strict';

// Apoio dos testes da esteira de CI da NAY (M9-D044): definição real, esteira falsa de 16 estágios (comandos triviais, na ordem do livro),
// execução do runner e leitura do relatório. Nada aqui toca o banco.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const API = path.join(__dirname, '..', '..', '..');
const EXECUTAR = path.join(API, 'scripts', 'ai-ci', 'executar.js');
const REAL = path.join(API, 'scripts', 'ai-ci', 'estagios.json');

const lerReal = () => JSON.parse(fs.readFileSync(REAL, 'utf8'));
const pastaTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'm9d044-'));

/** Anota o número do estágio no arquivo `traco` (uma linha por estágio que rodou). */
const anotar = (n, traco) => ['node', '-e', `require('fs').appendFileSync(${JSON.stringify(traco)}, '${n}\\n')`];

/**
 * Esteira falsa com os mesmos 16 estágios (mesmos números, nomes e tipos); os de 1 a 12 só anotam no rastro. `vermelho`: estágios que
 * terminam com erro depois de anotar; `ajustar(estagios)` altera a lista antes de gravar.
 */
function esteiraFalsa({ vermelho = [], ajustar } = {}) {
  const dir = pastaTemp();
  const traco = path.join(dir, 'traco.txt');
  const estagios = lerReal().estagios.map((e) => {
    if (e.tipo !== 'automatico') return { numero: e.numero, nome: e.nome, tipo: e.tipo, item: e.item };
    const comandos = [anotar(e.numero, traco)];
    if (vermelho.includes(e.numero)) comandos.push(['node', '-e', 'process.exit(1)']);
    return { numero: e.numero, nome: e.nome, tipo: e.tipo, comandos };
  });
  if (ajustar) ajustar(estagios);
  const arquivo = path.join(dir, 'estagios.json');
  fs.writeFileSync(arquivo, JSON.stringify({ estagios }));
  return { dir, arquivo, traco, rodou: () => (fs.existsSync(traco) ? fs.readFileSync(traco, 'utf8').split('\n').filter(Boolean).map(Number) : []) };
}

/** Roda scripts/ai-ci/executar.js; o relatório JSON vem junto. */
function executar(esteira, args = [], env = {}) {
  const relatorio = path.join(esteira.dir, 'relatorio.json');
  const log = path.join(esteira.dir, 'esteira.log');
  const r = spawnSync(process.execPath, [EXECUTAR, '--estagios', esteira.arquivo, '--log', log, '--relatorio', relatorio, ...args], {
    cwd: API, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return {
    status: r.status, saida: `${r.stdout}${r.stderr}`,
    relatorio: fs.existsSync(relatorio) ? JSON.parse(fs.readFileSync(relatorio, 'utf8')) : null,
    log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
  };
}

module.exports = { API, EXECUTAR, REAL, lerReal, pastaTemp, esteiraFalsa, executar };
