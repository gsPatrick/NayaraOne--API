'use strict';

/**
 * M9-D700 (3.6) — varredura de segurança do BI: nenhum caminho lê read model ou tabela do schema analytics sem passar pela
 * camada que confere permissão.
 *  R1  fora de src/features/analytics/read-models e dos arquivos de store soltos na raiz de src/features/analytics, nenhum arquivo cita `analytics.rm_*`.
 *  R2  arquivo da camada read-models que cita `analytics.rm_*` precisa importar a segurança (`../security`).
 *  R3  NAY (src/features/ai), exports e briefs não fazem SQL direto em `analytics.*`: chamam o serviço do BI.
 * Usada pelo teste m9d700 e por qualquer verificação de CI; só lê arquivos.
 */
const fs = require('node:fs');
const path = require('node:path');

// As tabelas de controle do worker (M9-D607) não guardam número de negócio: não são read models.
const RM = /\banalytics\.rm_(?!applied_events\b|stale_aggregates\b)[a-z0-9_]+/;
const SQL_ANALYTICS = /\b(?:FROM|JOIN|UPDATE|INTO)\s+"?analytics"?\./i;
const posix = (p) => p.split(path.sep).join('/');

function scanSource(relPath, content) {
  const file = posix(relPath);
  const out = [];
  const inReadModels = file.startsWith('src/features/analytics/read-models/');
  const inFeatures = /^src\/features\/analytics\/[^/]+$/.test(file); // stores soltos na raiz (as camadas ficam em subpastas)
  // M4-D140: migration (DDL) não lê o BI em tempo de execução; as da pasta raiz migrations/ já ficavam fora da varredura de src/,
  // e as do Financeiro moram em src/modules/finance/infrastructure/db/migrations/ (Guia M4 §2).
  const isMigration = /^src\/modules\/[^/]+\/infrastructure\/db\/migrations\//.test(file);
  if (RM.test(content) && !inReadModels && !inFeatures && !isMigration) {
    out.push({ file, rule: 'R1', message: 'cita read model do BI fora da camada read-models' });
  }
  if (inReadModels && RM.test(content) && !/require\((['"])\.\.\/security(\/[a-zA-Z.]*)?\1\)/.test(content)) {
    out.push({ file, rule: 'R2', message: 'read model lido sem importar a segurança (permissão, ABAC, mascaramento, log)' });
  }
  const restricted = /^src\/features\/ai\//.test(file) || /^src\/features\/analytics\/(exports|briefs)\//.test(file);
  if (restricted && SQL_ANALYTICS.test(content)) {
    out.push({ file, rule: 'R3', message: 'NAY, exportação ou brief faz SQL direto no BI; use o serviço de permissão' });
  }
  return out;
}

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, acc); } else if (e.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function scanRepo(root) {
  const src = path.join(root, 'src');
  return walk(src, []).flatMap((f) => scanSource(path.relative(root, f), fs.readFileSync(f, 'utf8')));
}

module.exports = { scanSource, scanRepo };
