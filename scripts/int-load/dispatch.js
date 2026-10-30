'use strict';

/**
 * M9-D255 3.3 — fase dos envios: o domínio pede `distintos` envios ao sandbox de mensageria e REPETE `repetidos` pedidos (mesma chave de idempotência);
 * o worker é rodado em paralelo (duas rodadas por vez) até a fila esvaziar. Nada de rede externa: o fornecedor é o messaging-sandbox.
 */
const crypto = require('node:crypto');
const { rodarEmPool, embaralhar } = require('./pool');

const ABERTOS = ['PENDING', 'RETRY_WAIT', 'SENDING'];
/** UUID estável derivado da chave (o agregado do envio é um UUID): a mesma chave sempre dá o mesmo agregado. */
const uuidDe = (chave) => { const h = crypto.createHash('sha256').update(chave).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const pausa = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function pedirEnvios(env, tenant, conexao, volume, rodada) {
  const chaves = Array.from({ length: volume.dispatches.distintos }, (_, i) => `load-${rodada}-d${i}`);
  const repeticoes = Array.from({ length: volume.dispatches.repetidos }, (_, i) => chaves[i % Math.max(chaves.length, 1)]);
  const sequencia = embaralhar([...chaves, ...repeticoes], 7);
  const recibos = await rodarEmPool(sequencia.length, volume.concurrency, async (i) => {
    const chave = sequencia[i];
    try {
      const r = await env.enfileirar(tenant, {
        connectionId: conexao.id, operation: 'sendText', aggregateType: 'Message', aggregateId: uuidDe(chave), idempotencyKey: chave, payload: { to: '+5541999990000', text: `Carga ${chave}` },
      });
      return { chave, dispatchId: r.dispatchId, criado: r.created };
    } catch (err) {
      return { chave, erro: err.code || err.message };
    }
  });
  return { chaves, recibos, pedidos: sequencia.length };
}

const abertos = (env, tenant, conexaoId) => env.sql(tenant, `SELECT count(*)::int AS n FROM integration.dispatches WHERE connection_id = :id AND status IN (${ABERTOS.map((s) => `'${s}'`).join(', ')})`, { id: conexaoId }).then((r) => r[0].n);

/** Roda duas rodadas do worker ao mesmo tempo (concorrência real) até não sobrar envio aberto ou estourar o prazo. Devolve as rodadas e se esvaziou. */
async function drenar(env, tenant, conexaoId, { prazoMs }) {
  const limite = Date.now() + prazoMs;
  let rodadas = 0;
  while (Date.now() < limite) {
    if ((await abertos(env, tenant, conexaoId)) === 0) return { rodadas, drenada: true };
    const ctx = env.ctxDe(tenant);
    const [a, b] = await Promise.all([env.dispatch.runDispatchCycle(ctx), env.dispatch.runDispatchCycle(ctx)]);
    rodadas += 2;
    if (a.claimed + b.claimed === 0) await pausa(200);
  }
  return { rodadas, drenada: (await abertos(env, tenant, conexaoId)) === 0 };
}

async function lerEnvios(env, tenant, conexaoId) {
  const envios = await env.sql(tenant, 'SELECT id, idempotency_key, status, attempts FROM integration.dispatches WHERE connection_id = :id', { id: conexaoId });
  const tentativas = await env.sql(tenant, 'SELECT dispatch_id, count(*)::int AS n FROM integration.dispatch_attempts WHERE connection_id = :id GROUP BY dispatch_id', { id: conexaoId });
  return { envios, tentativas, abertos: await abertos(env, tenant, conexaoId) };
}

module.exports = { pedirEnvios, drenar, lerEnvios, ABERTOS };
