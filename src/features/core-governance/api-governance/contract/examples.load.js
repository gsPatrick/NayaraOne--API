'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exampleInvalid } = require('./contract.errors');

const KINDS = ['positive', 'negative'];
const ACTORS = ['gestor', 'maker', 'anon', 'gestorB'];

/** Confere a forma de um exemplo; devolve o motivo ou null. */
function shapeProblem(example) {
  if (!example || typeof example !== 'object') return 'exemplo não é um objeto';
  if (typeof example.op !== 'string' || !/^[A-Z]+ \/\S*$/.test(example.op)) return 'op deve ser "MÉTODO /caminho do contrato"';
  if (!KINDS.includes(example.kind)) return `kind deve ser ${KINDS.join(' ou ')}`;
  if (typeof example.name !== 'string' || !example.name.trim()) return 'name é obrigatório';
  if (!ACTORS.includes(example.as)) return `as deve ser ${ACTORS.join(', ')}`;
  if (!Number.isInteger(example.expect) || example.expect < 200 || example.expect > 599) return 'expect deve ser o status HTTP esperado';
  const positive = example.expect < 300;
  if (positive !== (example.kind === 'positive')) return 'exemplo positivo espera 2xx e negativo espera 4xx';
  return null;
}

/** Lê todos os *.json da pasta: { examples: [{ file, ...exemplo }], findings }. A ordem (arquivos por nome, exemplos na ordem do arquivo) é a ordem de execução. */
function loadExamples(dir) {
  const examples = [];
  const findings = [];
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort() : [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      findings.push(exampleInvalid(`${file} não é JSON válido`, { file }));
      continue;
    }
    if (!data || !Array.isArray(data.examples)) { findings.push(exampleInvalid(`${file} deve ter "examples": lista`, { file })); continue; }
    data.examples.forEach((example, index) => {
      const problem = shapeProblem(example);
      if (problem) findings.push(exampleInvalid(problem, { file, index }));
      else examples.push({ file, ...example });
    });
  }
  return { examples, findings };
}

module.exports = { loadExamples, shapeProblem, KINDS, ACTORS };
