'use strict';

const crypto = require('node:crypto');

/** Objetos do sandbox de armazenamento, por connection (em memória: o sandbox não tem rede nem disco) e o segredo efêmero das URLs assinadas (M9-D242). */
const objects = new Map();
const SECRET = crypto.randomBytes(32).toString('hex');
const keyOf = (connectionId, key) => `${connectionId}|${key}`;

module.exports = {
  SECRET,
  put: (connectionId, key, entry) => objects.set(keyOf(connectionId, key), { ...entry, at: Date.now() }),
  get: (connectionId, key) => objects.get(keyOf(connectionId, key)) || null,
  remove: (connectionId, key) => objects.delete(keyOf(connectionId, key)),
  reset: () => objects.clear(),
  size: () => objects.size,
};
