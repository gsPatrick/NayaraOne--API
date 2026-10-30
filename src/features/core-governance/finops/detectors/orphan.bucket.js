'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { uploadsRoot } = require('../collectors/storage.measure');
const { RESERVED_SUFFIX } = require('../../../integrations/providers/storage/storage.key');

/**
 * Objetos do bucket da empresa (`<raiz>/company/<id>/...`) SEM linha em files, mais velhos que o corte (objeto recém-gravado pode ainda não ter a linha).
 * Só lê a pasta: nada é movido nem apagado. Os `.meta` são metadados do driver. Devolve { count, bytes } (BigInt); sem a pasta da empresa, zero.
 */
function bucketOrphans(companyId, known, cutoff, root = uploadsRoot()) {
  const base = path.join(root, 'company', String(companyId).toLowerCase());
  const out = { count: 0, bytes: 0n };
  if (!fs.existsSync(base)) return out;
  for (const rel of fs.readdirSync(base, { recursive: true })) {
    const file = path.join(base, String(rel));
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; } // removido durante a leitura
    if (!stat.isFile() || String(rel).endsWith(RESERVED_SUFFIX) || stat.mtime >= cutoff) continue;
    const key = `company/${String(companyId).toLowerCase()}/${String(rel).split(path.sep).join('/')}`;
    if (known.has(key)) continue;
    out.count += 1;
    out.bytes += BigInt(stat.size);
  }
  return out;
}

module.exports = { bucketOrphans };
