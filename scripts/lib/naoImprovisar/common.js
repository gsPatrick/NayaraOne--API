'use strict';

/**
 * Base das 7 guardas do "Não improvisar" (M9-D257, Guia §13). Cada guarda lê o código-fonte (nunca executa o que varre), devolve cada violação com arquivo e linha
 * e aceita uma raiz alternativa (`root`): é assim que os testes provam que a guarda FALHA diante de uma violação sintética. Exceção só entra pelo arquivo excecoes.json,
 * que começa vazio e exige `approvedBy` (aprovação do Patrick) em cada item.
 */
const fs = require('node:fs');
const path = require('node:path');
const { limparComentarios, listarArquivos } = require('../aiArchGuard');

const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const CODE = 'ARCH_RULE_VIOLATION';
const norm = (p) => p.split(path.sep).join('/');

const violation = (rule, file, line, message, snippet = '') => ({ code: CODE, rule, file, line, message, snippet: String(snippet).trim().slice(0, 160) });

/** Arquivos .js sob `root/sub` (caminhos relativos a `root`, com barra). Pasta inexistente = lista vazia. */
function listJs(root, sub) {
  const dir = path.join(root, sub);
  if (!fs.existsSync(dir)) return [];
  return listarArquivos(dir).filter((f) => f.endsWith('.js')).map((f) => norm(path.relative(root, f)));
}

/** Linhas do arquivo sem comentários (a numeração é a original). */
const codeLines = (root, rel) => limparComentarios(fs.readFileSync(path.join(root, rel), 'utf8')).split('\n');
const rawLines = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8').split('\n');

/** Lista de exceções aprovadas. Item sem `approvedBy` (ou sem motivo) vira violação: a lista é vazia por regra. */
function loadExceptions(file = path.join(__dirname, 'excecoes.json')) {
  const itens = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).excecoes || []) : [];
  const invalidas = itens.filter((e) => !(e && e.rule && e.file && e.approvedBy && e.reason)).map((e, i) => violation(0, norm(path.relative(API_ROOT, file)), i + 1, 'Exceção sem rule, file, reason e approvedBy (aprovação do Patrick).', JSON.stringify(e)));
  return { itens: itens.filter((e) => e && e.rule && e.file && e.approvedBy && e.reason), invalidas };
}

const ehExcecao = (v, itens) => itens.some((e) => Number(e.rule) === v.rule && e.file === v.file && (e.line === undefined || Number(e.line) === v.line));

const formatar = (vs) => vs.map((v) => `${v.file}:${v.line} [${v.code}] regra ${v.rule}: ${v.message} -> ${v.snippet}`).join('\n');

module.exports = { API_ROOT, CODE, norm, violation, listJs, codeLines, rawLines, loadExceptions, ehExcecao, formatar };
