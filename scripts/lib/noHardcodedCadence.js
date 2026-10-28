'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * M9-D417 (MKT-005) — teste estático `no-hardcoded-cadence`. Varre os .js do módulo Marketing e aponta literais de cadência,
 * horário de silêncio e frequency cap fora do arquivo de padrões (automations/cadence/cadence.defaults.js) e dos dicionários
 * `*.settings.js`. Reconhece: lista de 3+ inteiros crescentes (cadência), texto HH:MM (horário), 'America/Sao_Paulo' (fuso) e
 * texto "N mensagens por M dias" (cap). Comentários não contam. Usado por test/m9d417.cadenciaParametros.test.js e pela M9-D440.
 */
const ALLOWED = [/[\\/]cadence[\\/]cadence\.defaults\.js$/, /\.settings\.js$/];
const ARRAY_LITERAL = /\[\s*\d+(?:\s*,\s*\d+){2,}\s*\]/g;
const TIME_TEXT = /['"`][^'"`\n]*(?<![\dT:])(?:[01]\d|2[0-3]):[0-5]\d(?![\d:])[^'"`\n]*['"`]/g;
const TIMEZONE = /['"`]America\/Sao_Paulo['"`]/g;
const CAP_TEXT = /['"`][^'"`\n]*\d+\s+mensagens?\s+por\s+\d+\s+dias?[^'"`\n]*['"`]/g;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, (m, p1) => p1);
}

function isIncreasing(literal) {
  const nums = literal.match(/\d+/g).map(Number);
  return nums.every((n, i) => i === 0 || n > nums[i - 1]);
}

/** Devolve [{ file, line, kind, text }] para um conteúdo de arquivo. */
function scanSource(file, source) {
  if (ALLOWED.some((re) => re.test(file))) return [];
  const clean = stripComments(source);
  const found = [];
  const add = (re, kind, accept) => {
    for (const m of clean.matchAll(re)) {
      if (accept && !accept(m[0])) continue;
      found.push({ file, line: clean.slice(0, m.index).split('\n').length, kind, text: m[0].trim() });
    }
  };
  add(ARRAY_LITERAL, 'cadencia', isIncreasing);
  add(TIME_TEXT, 'horario_de_silencio');
  add(TIMEZONE, 'fuso');
  add(CAP_TEXT, 'frequency_cap');
  return found;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function scanDirectory(dir) {
  return walk(dir, []).flatMap((file) => scanSource(file, fs.readFileSync(file, 'utf8')));
}

module.exports = { scanSource, scanDirectory };
