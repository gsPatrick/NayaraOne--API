'use strict';

/**
 * Regra 2 — "Não consultar OLTP pesado a cada dashboard". Guarda estático da importação (a contagem de tabelas tocadas em runtime é da
 * M9-D698/D612): o código que atende `GET /analytics/dashboards/:code` não importa feature de domínio nem modelo do OLTP e só cita SQL
 * no schema `analytics`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { API_ROOT, listFiles, violation, lineOf } = require('./files');

const DASHBOARD_SCOPE = [
  path.join('src', 'features', 'analytics', 'dashboards'),
  path.join('src', 'features', 'analytics', 'dashboardReadStore.service.js'),
];
const DOMAIN_FEATURE = /require\((['"])(?:\.\.\/)+(?:features\/|modules\/)?(?!analytics\b|settings\b)(finance|crm|billing|contracts|legal|construction|inventory|procurement|properties|people|correspondent|marketing|radar|fiscal)\b[^'"]*\1\)/;
const OLTP_MODEL = /require\((['"])(?:\.\.\/)+models(?:\/[^'"]*)?\1\)/;
const FOREIGN_SQL = /\b(?:FROM|JOIN)\s+"?([a-z_]+)"?\."?[a-z_]+/gi;

function scopeFiles(root) {
  return DASHBOARD_SCOPE.flatMap((rel) => {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? listFiles(full, /\.js$/) : [full];
  });
}

function checkRule2(root = API_ROOT) {
  const out = [];
  for (const file of scopeFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    const feature = DOMAIN_FEATURE.exec(text);
    if (feature) out.push(violation(2, rel, `O painel importa a feature de domínio "${feature[2]}"; leia só o schema analytics.`, lineOf(text, feature.index)));
    const model = OLTP_MODEL.exec(text);
    if (model && /\b(?:findAll|findOne|findByPk|count)\s*\(/.test(text)) out.push(violation(2, rel, 'O painel consulta modelo do OLTP; leia só o schema analytics.', lineOf(text, model.index)));
    for (const m of text.matchAll(FOREIGN_SQL)) {
      if (m[1].toLowerCase() !== 'analytics') out.push(violation(2, rel, `O painel lê a tabela do schema "${m[1]}" a cada abertura; leia só o schema analytics.`, lineOf(text, m.index)));
    }
  }
  return { scanned: scopeFiles(root).length, violations: out };
}

module.exports = { checkRule2 };
