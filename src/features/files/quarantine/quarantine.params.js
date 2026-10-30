'use strict';

const { getSetting } = require('../../settings/settings.service');

const TIPOS = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/amr', 'audio/wav', 'video/mp4', 'video/webm', 'video/quicktime',
];
const PADROES = Object.freeze({ maxBytes: 26214400, ttlHours: 72, zipMaxDepth: 3, zipMaxRatio: 100, allowedTypes: TIPOS.join(',') });
const inteiro = (v, padrao, min) => (Number.isInteger(v) && v >= min ? v : padrao);

/** Parâmetros da quarentena da empresa (padrões do parametros.csv quando não configurados). */
async function readQuarantineParams(tenant, transaction) {
  const [max, ttl, depth, ratio, tipos] = await Promise.all([
    getSetting('integration.upload.max_bytes', tenant, transaction, PADROES.maxBytes),
    getSetting('integration.upload.quarantine_ttl_hours', tenant, transaction, PADROES.ttlHours),
    getSetting('integration.upload.zip_max_depth', tenant, transaction, PADROES.zipMaxDepth),
    getSetting('integration.upload.zip_max_ratio', tenant, transaction, PADROES.zipMaxRatio),
    getSetting('integration.upload.allowed_types', tenant, transaction, PADROES.allowedTypes),
  ]);
  const lista = String(tipos).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    maxBytes: inteiro(max, PADROES.maxBytes, 1024), ttlHours: inteiro(ttl, PADROES.ttlHours, 1), zipMaxDepth: inteiro(depth, PADROES.zipMaxDepth, 1), zipMaxRatio: inteiro(ratio, PADROES.zipMaxRatio, 2),
    allowedTypes: lista.length ? lista : TIPOS,
  };
}

module.exports = { readQuarantineParams, PADROES };
