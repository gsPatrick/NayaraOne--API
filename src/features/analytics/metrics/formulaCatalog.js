'use strict';

/**
 * M9-D603 (3.3) — catálogo de fórmulas DO CÓDIGO. Cada arquivo de `./formulas/*.js` exporta
 * `{ id, version, compute(readModelRows, params), testCases }`; o banco só guarda o `formula_id`.
 * O contrato completo da fórmula (aritmética, arredondamento, lint) é da M9-D605; aqui ficam o carregamento,
 * a checagem de consistência e o dry-run de testes exigido na publicação (3.2 d).
 * `testCases`: lista de `{ name, input, params, expected }`. Sem casos, a fórmula não publica.
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const DEFAULT_DIR = path.join(__dirname, 'formulas');
const SKIP = new Set(['index.js', 'money.js']);

/** JSON canônico (chaves ordenadas; BigInt e objetos com toString viram texto) para comparar e gerar hash. */
function canonical(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value.toFixed === 'function' && typeof value.toString === 'function' && !(value instanceof Date)) {
    return JSON.stringify(value.toString());
  }
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function isFormulaFile(name) {
  return name.endsWith('.js') && !name.endsWith('.test.js') && !name.startsWith('_') && !SKIP.has(name);
}

function loadFormulas(dir, codeHashes) {
  const byId = new Map();
  if (!fs.existsSync(dir)) return byId;
  for (const name of fs.readdirSync(dir).filter(isFormulaFile).sort()) {
    const f = require(path.join(dir, name));
    if (!f || typeof f.id !== 'string' || !f.id.trim() || !Number.isInteger(f.version) || typeof f.compute !== 'function') {
      throw new Error(`Fórmula inválida em ${name}: exporte id (texto), version (inteiro) e compute (função).`);
    }
    if (byId.has(f.id)) throw new Error(`Fórmula duplicada no código: ${f.id}.`);
    byId.set(f.id, f);
    codeHashes.set(f.id, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex'));
  }
  return byId;
}

function createFormulaCatalog(dir = DEFAULT_DIR) {
  const codeHashes = new Map(); // M9-D614 regra 4: SHA-256 do ARQUIVO da fórmula, guardado na versão publicada (formula_code_hash)
  const byId = loadFormulas(dir, codeHashes);
  return {
    codeHash: (id) => codeHashes.get(id) || null,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id) || null,
    ids: () => [...byId.keys()],
  };
}

let defaultCatalog = null;
function getFormulaCatalog() {
  if (!defaultCatalog) defaultCatalog = createFormulaCatalog();
  return defaultCatalog;
}

/**
 * Dry-run dos testes da fórmula. `hash` = SHA-256 de id, versão e resultados canônicos de todos os casos: muda
 * se a fórmula ou o conjunto de testes mudar. Fórmula sem testCases não passa.
 */
function runFormulaTests(formula) {
  const cases = Array.isArray(formula.testCases) ? formula.testCases : [];
  const failures = [];
  const results = [];
  if (!cases.length) failures.push({ name: '(nenhum caso)', reason: 'A fórmula não declara testCases.' });
  cases.forEach((c, i) => {
    const name = (c && c.name) || `caso ${i + 1}`;
    try {
      const actual = formula.compute(c.input, c.params || {});
      results.push(actual);
      if (canonical(actual) !== canonical(c.expected)) failures.push({ name, reason: 'Resultado diferente do esperado.' });
    } catch (err) {
      failures.push({ name, reason: `A fórmula lançou erro: ${err.message}` });
    }
  });
  const hash = createHash('sha256').update(`${formula.id}|${formula.version}|${canonical(results)}`).digest('hex');
  return { ok: failures.length === 0, hash, failures, total: cases.length };
}

module.exports = { createFormulaCatalog, getFormulaCatalog, runFormulaTests, canonical, isFormulaFile, DEFAULT_DIR };
