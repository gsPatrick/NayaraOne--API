'use strict';

const crypto = require('node:crypto');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const normalizeText = (value) => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Hash do pedido normalizado (tarefa, pergunta e finalidade sem diferença de caixa ou espaço). */
const requestHash = ({ taskType, input, purpose }) => sha256(JSON.stringify([normalizeText(taskType), normalizeText(input), normalizeText(purpose)]));

/** Permissões efetivas, sem repetição e em ordem: o mesmo conjunto gera sempre a mesma chave. */
const sortedPermissions = (permissions) => [...new Set((permissions || []).map(String))].sort();

/** Parte da chave conhecida ANTES de buscar fontes: empresa, agente, versão, tarefa, permissões e pedido. O MODELO não entra. */
function scopeKey({ companyId, agentCode, agentVersion, taskType, permissions, request }) {
  return sha256(JSON.stringify([String(companyId), String(agentCode).toUpperCase(), Number(agentVersion), normalizeText(taskType), sortedPermissions(permissions), request]));
}

/** Descritor das fontes usadas ({t,r,v}), em ordem estável: é o que se confere para invalidar. */
const sourceDescriptors = (sources) => (sources || [])
  .map((s) => ({ t: s.sourceType, r: s.sourceRef === undefined || s.sourceRef === null ? null : String(s.sourceRef), v: s.sourceVersion === undefined || s.sourceVersion === null ? null : String(s.sourceVersion) }))
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** Chave completa: o escopo mais as fontes (tipo, referência, versão, conteúdo) e o snapshot_at delas. */
function cacheKey(scope, { sources, snapshotAt }) {
  const parts = (sources || []).map((s) => [s.sourceType, s.sourceRef, s.sourceVersion, s.contentHash || null]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha256(JSON.stringify([scope, parts, snapshotAt ? new Date(snapshotAt).toISOString() : null]));
}

module.exports = { requestHash, scopeKey, cacheKey, sourceDescriptors, sortedPermissions, normalizeText };
