'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PATTERNS } = require('./secretScanPatterns');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SKIP = /(^|\/)(node_modules|\.git)\/|package-lock\.json$|\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|zip|gz|sqlite|enc)$/i;
const SELF = /^(scripts\/lib\/secretScanPatterns\.js|scripts\/secretScan\.allowlist\.json)$/;

function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 256 * 1024 * 1024 });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch (_) {
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') walk(full); } else found.push(path.relative(root, full));
      }
    };
    walk(root);
    return found;
  }
}

/** Mostra só o começo do achado: o relatório nunca repete o segredo inteiro. */
const mask = (text) => `${text.slice(0, 4)}***(${text.length} caracteres)`;

function loadAllowlist(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')).entries || [];
}

function isAllowed(allowlist, file, pattern) {
  return allowlist.some((e) => e.pattern === pattern && e.reason && e.reviewedBy && new RegExp(e.file).test(file));
}

/** Varre os arquivos do repositório (rastreados e novos) e devolve { findings, scanned }. */
function scanRepository({ root, allowlistFile, extraFiles = [] }) {
  const allowlist = loadAllowlist(allowlistFile);
  const files = [...new Set([...listFiles(root), ...extraFiles])];
  const findings = [];
  let scanned = 0;
  for (const rel of files) {
    if (SKIP.test(rel) || SELF.test(rel)) continue;
    const full = path.join(root, rel);
    let buf;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      buf = fs.readFileSync(full);
    } catch (_) { continue; }
    if (buf.includes(0)) continue;
    scanned += 1;
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      if (line.length > 20000) return;
      for (const { name, re } of PATTERNS) {
        const m = line.match(re);
        if (m && !isAllowed(allowlist, rel, name)) findings.push({ file: rel, line: i + 1, pattern: name, sample: mask(m[0]) });
      }
    });
  }
  return { findings, scanned };
}

module.exports = { scanRepository, listFiles, mask, isAllowed };
