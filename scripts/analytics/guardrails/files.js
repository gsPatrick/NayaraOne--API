'use strict';

// M9-D614 — apoio dos 7 guardas: lista de arquivos de código e leitura linha a linha. Só lê arquivos; nenhum guarda tem modo de desligar.
const fs = require('node:fs');
const path = require('node:path');

const API_ROOT = path.join(__dirname, '..', '..', '..');
const FRONT_ROOT = path.join(API_ROOT, '..', 'NayaraOne--FRONT');

function listFiles(dir, extPattern, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, extPattern, out);
    else if (extPattern.test(entry.name)) out.push(full);
  }
  return out;
}

const violation = (rule, file, message, line) => ({ rule, file, line: line || null, message });
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

module.exports = { API_ROOT, FRONT_ROOT, listFiles, violation, lineOf };
