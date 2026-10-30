'use strict';

/**
 * Registros do sandbox (em memória, como os demais sandboxes do bloco B: sem rede nem banco). Chave = escopo (a empresa) + canal + chave de
 * idempotência: a mesma chave devolve o mesmo registro. `revoked` guarda a credencial revogada por escopo e canal.
 */
const records = new Map();
const revoked = new Set();
const k = (scope, channel, key) => `${scope}|${channel}|${key}`;

const putRecord = (scope, channel, key, record) => { records.set(k(scope, channel, key), record); return record; };
const getRecord = (scope, channel, key) => records.get(k(scope, channel, key)) || null;
const findByRef = (scope, channel, ref) => [...records.entries()].find(([id, r]) => id.startsWith(`${scope}|${channel}|`) && r.providerRef === ref)?.[1] || null;
const countRecords = (scope, channel) => [...records.keys()].filter((id) => id.startsWith(`${scope}|${channel}|`)).length;
const revoke = (scope, channel) => revoked.add(`${scope}|${channel}`);
const isRevoked = (scope, channel) => revoked.has(`${scope}|${channel}`);
const resetSandbox = () => { records.clear(); revoked.clear(); };

module.exports = { putRecord, getRecord, findByRef, countRecords, revoke, isRevoked, resetSandbox };
