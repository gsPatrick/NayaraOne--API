'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../../models');
const logVolume = require('../../../../shared/log-volume/counter');

/** Bytes por tipo (parte principal do mime) dos arquivos vivos da empresa no módulo de arquivos. */
async function filesByType(tenant, transaction) {
  const rows = await sequelize.query(
    `SELECT COALESCE(NULLIF(split_part(mime_type, '/', 1), ''), 'outros') AS kind, COALESCE(SUM(size_bytes), 0)::bigint AS bytes
       FROM people.files WHERE company_id = :companyId AND deleted_at IS NULL GROUP BY 1 ORDER BY 1`,
    { type: QueryTypes.SELECT, transaction, replacements: { companyId: tenant.companyId } }
  );
  return rows.map((r) => ({ service: `files:${r.kind}`, companyId: tenant.companyId, bytes: BigInt(r.bytes), unit: 'storage' }));
}

function directoryBytes(root) {
  let total = 0n;
  for (const rel of fs.readdirSync(root, { recursive: true })) {
    try {
      const stat = fs.statSync(path.join(root, String(rel)));
      if (stat.isFile()) total += BigInt(stat.size);
    } catch (_) { /* arquivo removido durante a medição */ }
  }
  return total;
}

/** Bytes no bucket (o armazenamento físico dos binários: UPLOADS_DIR ou uploads/), custo compartilhado. Sem a pasta, não há o que medir: nada é gravado. */
function bucketBytes() {
  const root = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(__dirname, '..', '..', '..', '..', '..', 'uploads');
  if (!fs.existsSync(root)) return [];
  return [{ service: 'bucket', companyId: null, bytes: directoryBytes(root), unit: 'storage' }];
}

/** Volume de log do dia fechado (contador do logger); dia que este processo não observou não vira linha. */
function logBytes(dayKey) {
  const bytes = logVolume.bytesOfDay(dayKey);
  return bytes === null ? [] : [{ service: 'logs', companyId: null, bytes: BigInt(bytes), unit: 'logs' }];
}

/** Todas as medições do dia fechado: arquivos por tipo (empresa), bucket e logs (compartilhados). */
async function measureAll(tenant, dayKey, transaction) {
  return [...await filesByType(tenant, transaction), ...bucketBytes(), ...logBytes(dayKey)];
}

module.exports = { measureAll, filesByType, bucketBytes, logBytes };
