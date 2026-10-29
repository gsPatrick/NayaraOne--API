'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Varredura dos códigos de erro de um diretório de fontes (M9-D843 §3.4). Acha as chamadas `govError(status, 'CODIGO', 'mensagem')`, `new AppError('mensagem', status, 'CODIGO')` e
 * `AppError.<tipo>('mensagem', 'CODIGO')` e os literais 'GOV_...' de qualquer lugar (códigos escolhidos por tabela, como o da guarda do DLP). Devolve:
 *   { used: Map(codigo -> { status, message, files:Set }), calls: [{ code, file, line }], literals: Set }
 * `calls` são as chamadas diretas (para a regra de prefixo GOV_ da K4); `literals` são os 'GOV_*' soltos (para a completude do catálogo).
 */
const STATUS_BY_FACTORY = { badRequest: 400, unauthorized: 401, forbidden: 403, notFound: 404, conflict: 409, unprocessable: 422, internal: 500 };

/** Lê um literal de texto (aspas simples, duplas ou crase) a partir de `index`; devolve { text, end } com `${...}` trocado por <valor>. */
function readLiteral(source, index) {
  const quote = source[index];
  if (!['\'', '"', '`'].includes(quote)) return null;
  let text = '';
  let i = index + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { text += source[i + 1] === 'n' ? ' ' : source[i + 1]; i += 2; continue; }
    if (ch === quote) return { text, end: i + 1 };
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) { if (source[i] === '{') depth += 1; else if (source[i] === '}') depth -= 1; i += 1; }
      text += '<valor>';
      continue;
    }
    text += ch;
    i += 1;
  }
  return null;
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;
const clean = (text) => text.replace(/\s+/g, ' ').trim();

function scanSource(source, file, out) {
  const prefixes = new Set([...source.matchAll(/startsWith\('(GOV_[A-Z0-9_]+)'\)/g)].map((m) => m[1])); // prefixo de teste (ex.: GOV_EVIDENCE) não é código
  for (const m of source.matchAll(/'(GOV_[A-Z0-9_]+)'/g)) if (!prefixes.has(m[1])) out.literals.add(m[1]);
  const record = (code, status, message, index) => {
    out.calls.push({ code, file, line: lineOf(source, index) });
    const known = out.used.get(code) || { status: null, message: null, files: new Set() };
    if (status && !known.status) known.status = status;
    if (message && !known.message) known.message = clean(message);
    known.files.add(file);
    out.used.set(code, known);
  };
  for (const m of source.matchAll(/\bgovError\(\s*(\d{3})\s*,\s*'([A-Za-z0-9_]+)'\s*,\s*/g)) {
    const lit = readLiteral(source, m.index + m[0].length);
    record(m[2], Number(m[1]), lit ? lit.text : null, m.index);
  }
  for (const m of source.matchAll(/new AppError\(\s*/g)) {
    const lit = readLiteral(source, m.index + m[0].length);
    if (!lit) continue;
    const rest = /^\s*,\s*(\d{3})\s*,\s*'([A-Za-z0-9_]+)'/.exec(source.slice(lit.end, lit.end + 80));
    if (rest) record(rest[2], Number(rest[1]), lit.text, m.index);
  }
  for (const m of source.matchAll(/\bAppError\.(badRequest|unauthorized|forbidden|notFound|conflict|unprocessable|internal)\(\s*/g)) {
    const lit = readLiteral(source, m.index + m[0].length);
    if (!lit) continue;
    const rest = /^\s*,\s*'([A-Za-z0-9_]+)'/.exec(source.slice(lit.end, lit.end + 80));
    if (rest) record(rest[1], STATUS_BY_FACTORY[m[1]], lit.text, m.index);
  }
}

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...listJs(full)); } else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

function scanDir(dir) {
  const out = { used: new Map(), calls: [], literals: new Set() };
  for (const file of listJs(dir)) scanSource(fs.readFileSync(file, 'utf8'), path.relative(dir, file).split(path.sep).join('/'), out);
  return out;
}

module.exports = { scanDir, scanSource, readLiteral };
