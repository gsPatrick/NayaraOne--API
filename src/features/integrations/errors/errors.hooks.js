'use strict';

/**
 * Tratadores da resolução humana de um erro (M9-D237): o módulo dono de um código de erro registra UMA função que o `resolveError` chama, na MESMA transação, quando a
 * pessoa informa uma decisão (`decision`). Ex.: o Financeiro leva o envio de valor divergente a FAILED. Lançar erro desfaz também a resolução. `fn({ error, decision, ctx, transaction })`.
 */
const handlers = new Map();

const registerResolveHandler = (errorCode, fn) => { handlers.set(String(errorCode), fn); return () => handlers.delete(String(errorCode)); };
const getResolveHandler = (errorCode) => handlers.get(String(errorCode)) || null;

module.exports = { registerResolveHandler, getResolveHandler };
