'use strict';

const crypto = require('node:crypto');

/** Espaço de nomes fixo do calendário (uuid v5 determinístico; não é segredo). */
const CALENDAR_NAMESPACE = '6f1d3a52-8c0e-5b7a-9d41-2f6b8e0c7a13';

function uuidV5(name, namespace = CALENDAR_NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(String(name)).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** source_id do item PROJECT_WARRANTY: não pode colidir com o da própria obra (CONSTRUCTION), que usa o id da obra. */
function projectWarrantySourceId(projectId) {
  return uuidV5(`${projectId}:WARRANTY`);
}

module.exports = { uuidV5, projectWarrantySourceId, CALENDAR_NAMESPACE };
