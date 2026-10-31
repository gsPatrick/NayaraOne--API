'use strict';

const crypto = require('node:crypto');

/**
 * Seleção do canary (M9-D904 §3.2): estável e determinística. Ordenam-se os usuários do setor pelo SHA-256 do id (crescente, em hexadecimal; empate pelo id) e os primeiros
 * ceil(N × percentual / 100) operam no sistema novo. Subir a etapa só acrescenta usuários: o prefixo da ordem é sempre o mesmo.
 */
const hashOf = (userId) => crypto.createHash('sha256').update(String(userId)).digest('hex');

function orderByHash(userIds) {
  return [...new Set(userIds.map(String))].map((id) => ({ id, hash: hashOf(id) }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : (a.id < b.id ? -1 : 1))).map((item) => item.id);
}

/** Teto da razão em inteiros (sem ponto flutuante). */
const canarySize = (total, percent) => Math.min(total, Math.floor((total * Math.max(0, percent) + 99) / 100));

const selectedUsers = (userIds, percent) => orderByHash(userIds).slice(0, canarySize(new Set(userIds.map(String)).size, percent));

module.exports = { hashOf, orderByHash, canarySize, selectedUsers };
