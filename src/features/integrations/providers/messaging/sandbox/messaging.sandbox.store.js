'use strict';

const crypto = require('node:crypto');

/**
 * Mensagens do sandbox de mensageria (M9-D229 3.2 item 5), em memória (o sandbox não tem rede nem banco). Cada mensagem pertence a uma connection e à chave de
 * idempotência do envio: repetir a chave devolve a MESMA mensagem (um único recurso externo). A entrega simulada tem atraso configurável: até lá o status é SENT;
 * depois, DELIVERED. `force` fixa um status (o teste fala o que o aparelho fez, como o webhook faria).
 */
const mensagens = new Map();
let contador = 0;

const sha = (...partes) => crypto.createHash('sha256').update(partes.join('|')).digest('hex');
const chaveDe = (connectionId, chave) => `${connectionId}|${chave}`;

/** Cria (ou devolve, pela mesma chave) a mensagem. Sem chave, cada envio é uma mensagem nova. Devolve { message, duplicate }. */
function create(connectionId, chave, prefixo, dados, agora = Date.now()) {
  const k = chaveDe(connectionId, chave || `auto-${(contador += 1)}`);
  if (mensagens.has(k)) return { message: mensagens.get(k), duplicate: true };
  const message = { id: `${prefixo}-${sha(k).slice(0, 16)}`, connectionId, key: chave || null, ...dados, createdAt: agora, forced: null };
  mensagens.set(k, message);
  return { message, duplicate: false };
}

const findById = (connectionId, id) => [...mensagens.values()].find((m) => m.connectionId === connectionId && m.id === id) || null;
const findByKey = (connectionId, chave) => mensagens.get(chaveDe(connectionId, chave)) || null;

/** Status interno da mensagem no instante: o fixado pelo teste; senão SENT antes do atraso e DELIVERED depois. */
function statusAt(message, delayMs, agora = Date.now()) {
  if (message.forced) return message.forced;
  return agora - message.createdAt >= (Number(delayMs) > 0 ? Number(delayMs) : 0) ? 'DELIVERED' : 'SENT';
}

function force(connectionId, id, status) {
  const m = findById(connectionId, id);
  if (m) m.forced = status;
  return m;
}

const reset = () => { mensagens.clear(); contador = 0; };

module.exports = { create, findById, findByKey, statusAt, force, reset };
