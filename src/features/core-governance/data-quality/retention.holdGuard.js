'use strict';

/**
 * Interface do bloqueio legal (legal hold) para a retenção (M9-D911 §3.3.3). Até a M9-D912 existir ela é um STUB que devolve falso; a M9-D912 chama `setProvider` com
 * `isOnHold(entityType, entityId, ctx) -> Promise<boolean>` (e, se quiser lote, `heldIds(entityType, ids, ctx) -> Promise<string[]>`). A retenção consulta o guarda
 * na simulação e DE NOVO no lote do apply, dentro da transação: hold que apareceu depois da simulação impede o descarte.
 */
const CHUNK = 200;
let provider = { isOnHold: async () => false };

const setProvider = (next) => { provider = next; };
const resetProvider = () => { provider = { isOnHold: async () => false }; };
const isOnHold = (entityType, entityId, ctx) => provider.isOnHold(entityType, entityId, ctx);

/** Das chaves pedidas, as que estão sob hold (usa o lote do provedor, se existir; senão pergunta uma a uma, em grupos). */
async function heldIds(entityType, ids, ctx) {
  if (typeof provider.heldIds === 'function') return provider.heldIds(entityType, ids, ctx);
  const held = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const flags = await Promise.all(part.map((id) => provider.isOnHold(entityType, id, ctx)));
    part.forEach((id, index) => { if (flags[index]) held.push(id); });
  }
  return held;
}

module.exports = { isOnHold, heldIds, setProvider, resetProvider };
