'use strict';

const crypto = require('node:crypto');
const { replay } = require('../webhooks.errors');

/** Horário assinado do evento em milissegundos: o verificador devolve segundos (padrão) ou milissegundos (valor acima de 10^12). */
const timestampMs = (ts) => (Number.isFinite(ts) ? (ts > 1e12 ? ts : ts * 1000) : null);

/**
 * Janela de tempo (M9-D213 3.1 camada 1): com horário assinado pelo fornecedor, |agora - horário| acima da tolerância é replay (401). Sem horário assinado vale só
 * a camada 2 (a UNIQUE da caixa de entrada). Antes de ler o JSON: um replay nunca chega ao parse.
 */
function assertFreshTimestamp(timestamp, toleranceS, now = new Date()) {
  const ms = timestampMs(timestamp);
  if (ms === null) return;
  if (Math.abs(now.getTime() - ms) > toleranceS * 1000) throw replay();
}

/** Identificador derivado (camada 2) para o fornecedor que não manda id: sha256(fornecedor:horário assinado:hash do corpo). */
function derivedEventId(provider, timestamp, bodyHash) {
  return crypto.createHash('sha256').update(`${provider}:${Number.isFinite(timestamp) ? timestamp : ''}:${bodyHash}`).digest('hex');
}

module.exports = { assertFreshTimestamp, derivedEventId, timestampMs };
