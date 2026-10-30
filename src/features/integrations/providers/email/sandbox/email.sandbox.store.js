'use strict';

const crypto = require('node:crypto');

/**
 * Mensagens do sandbox de e-mail, por connection e chave de idempotência (em memória: o sandbox não tem rede nem banco), M9-D234. A mesma chave devolve o mesmo
 * identificador de mensagem, como um provedor de verdade que respeita a chave. O estado de entrega só muda quando o laboratório injeta o desfecho (`setDelivery`),
 * como o provedor faria por webhook; sem isso a mensagem fica SENT.
 */
const messages = new Map();
const sha = (...partes) => crypto.createHash('sha256').update(partes.join('|')).digest('hex');
const keyOf = (connectionId, chave) => `${connectionId}|${chave}`;
const erroHttp = (status, message) => Object.assign(new Error(message), { status });

/** Cria (ou devolve, pela mesma chave) a mensagem do sandbox. Id determinístico: o mesmo pedido gera sempre o mesmo identificador. */
function send(connectionId, chave, request) {
  const k = keyOf(connectionId, chave);
  if (!messages.has(k)) {
    messages.set(k, { id: `sbx-em-${sha(connectionId, chave).slice(0, 16)}`, connectionId, key: chave, to: request.to, subject: request.subject, status: 'SENT', at: Date.now() });
  }
  return messages.get(k);
}

const findById = (connectionId, id) => [...messages.values()].find((m) => m.connectionId === connectionId && m.id === id) || null;
const findByKey = (connectionId, chave) => messages.get(keyOf(connectionId, chave)) || null;

/** O laboratório injeta o desfecho do provedor para a mensagem (o que o webhook informaria). */
function setDelivery(connectionId, id, status) {
  const m = findById(connectionId, id);
  if (m) m.status = status;
  return m;
}

/** Caixa de entrada do laboratório (M9-D235): mensagens que o provedor teria recebido, lidas por cursor (posição na lista). */
const inbound = new Map();
const injectInbound = (connectionId, msg) => { const l = inbound.get(connectionId) || []; l.push(msg); inbound.set(connectionId, l); return l.length; };
function listInbound(connectionId, cursor, pageSize) {
  const lista = inbound.get(connectionId) || [];
  const de = Math.max(0, Number.parseInt(cursor, 10) || 0);
  const ate = Math.min(lista.length, de + Math.max(1, Number(pageSize) || 50));
  return { items: lista.slice(de, ate).map((m) => ({ externalMessageId: m.id, ...m })), nextCursor: String(ate), done: ate >= lista.length };
}

const reset = () => { messages.clear(); inbound.clear(); };

module.exports = { send, findById, findByKey, setDelivery, injectInbound, listInbound, erroHttp, reset };
