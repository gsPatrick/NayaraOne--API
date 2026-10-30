'use strict';

/**
 * M9-D255 3.3 — fase dos webhooks: o fornecedor entrega `distintos` eventos e REENTREGA `repetidos` (mesmo id), tudo assinado, pela rota pública real
 * (POST /v1/webhooks/:provider/:canal). Depois confere a caixa de entrada (webhook_inbox).
 */
const { rodarEmPool, embaralhar } = require('./pool');

async function enviarWebhooks(env, tenant, volume, rodada) {
  const canal = await env.criarCanal(tenant, { provider: 'messaging-sandbox' });
  const ids = Array.from({ length: volume.webhooks.distintos }, (_, i) => `load-${rodada}-w${i}`);
  const reentregas = Array.from({ length: volume.webhooks.repetidos }, (_, i) => ids[i % Math.max(ids.length, 1)]);
  const sequencia = embaralhar([...ids, ...reentregas]);
  const respostas = await rodarEmPool(sequencia.length, volume.concurrency, async (i) => {
    const corpo = Buffer.from(JSON.stringify({ id: sequencia[i], type: 'message.status', n: i }), 'utf8');
    try {
      const r = await env.postar(`/v1/webhooks/${canal.provider}/${canal.canal}`, corpo, env.assinar(canal.segredo, corpo));
      return { id: sequencia[i], status: r.status, resultado: r.json && r.json.status };
    } catch (err) {
      return { id: sequencia[i], status: 0, resultado: err.message };
    }
  });
  return { canal, ids, respostas, enviados: sequencia.length };
}

/** Lê o que ficou na caixa de entrada da connection do canal: linhas, ids distintos e ids que apareceram mais de uma vez. */
async function lerInbox(env, tenant, connectionId) {
  const linhas = await env.sql(tenant, 'SELECT external_event_id, status FROM integration.webhook_inbox WHERE connection_id = :id', { id: connectionId });
  const contagem = new Map();
  linhas.forEach((l) => contagem.set(l.external_event_id, (contagem.get(l.external_event_id) || 0) + 1));
  return { linhas: linhas.length, contagem, repetidosNaInbox: [...contagem].filter(([, n]) => n > 1).map(([id]) => id) };
}

module.exports = { enviarWebhooks, lerInbox };
