'use strict';

// Apoio dos testes da esteira de CI do Marketing (M9-D438): estágios de brinquedo (cada um escreve numa marca), execução do runner como processo e leitura do relatório. Não é teste.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const E = require('../../../scripts/marketing/ci/lib/estagios');

const RAIZ = path.join(__dirname, '..', '..', '..');
const EXECUTAR = path.join(RAIZ, 'scripts', 'marketing', 'ci', 'executar.js');

/** Comando de brinquedo: escreve o número do estágio na marca e sai com `codigo`. */
const marcar = (numero, codigo = 0) => ['node', '-e', `require('fs').appendFileSync(process.env.M9D438_MARCA, '${numero}\\n'); process.exit(${codigo});`];

/** Os 14 estágios do livro com comandos de brinquedo. `sobrescrever`: { [numero]: parteDoEstagio }. */
function estagiosDeBrinquedo(sobrescrever = {}) {
  return E.ESTAGIOS_DO_LIVRO.map(([numero, nome]) => ({ numero, nome, tipo: numero <= E.ULTIMO_DE_PUSH ? 'push' : 'entrega', comandos: [marcar(numero)], ...(sobrescrever[numero] || {}) }));
}

/** Roda o runner com um arquivo de estágios. Devolve { status, saida, marcas (números que rodaram), relatorio }. */
function executar(estagios, args = [], env = {}, { raiz = RAIZ, executavel = EXECUTAR } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9d438-'));
  const arquivo = path.join(dir, 'estagios.json');
  const marca = path.join(dir, 'marca.txt');
  const relatorio = path.join(dir, 'relatorio.json');
  fs.writeFileSync(arquivo, JSON.stringify({ estagios }));
  fs.writeFileSync(marca, '');
  const r = spawnSync('node', [executavel, '--estagios', arquivo, '--relatorio', relatorio, ...args], { cwd: raiz, encoding: 'utf8', env: { ...process.env, M9D438_MARCA: marca, DISPOSABLE_DB: '', ...env } });
  const marcas = fs.readFileSync(marca, 'utf8').split('\n').filter(Boolean).map(Number);
  const rel = fs.existsSync(relatorio) ? JSON.parse(fs.readFileSync(relatorio, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, saida: `${r.stdout}${r.stderr}`, marcas, relatorio: rel };
}

const lerEstagios = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'scripts', 'marketing', 'ci', 'estagios.json'), 'utf8')).estagios;

module.exports = { RAIZ, EXECUTAR, marcar, estagiosDeBrinquedo, executar, lerEstagios, E };
