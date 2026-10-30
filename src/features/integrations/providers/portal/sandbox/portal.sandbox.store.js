'use strict';

/**
 * Estado simulado dos portais sandbox (M9-D232): o que cada portal "guarda" por connection e id do anúncio, o registro das chamadas e as falhas injetáveis dos testes
 * (portal fora do ar, remoção que responde 200 mas não remove, reprovação do anúncio). Em memória; não é dado de negócio.
 */
const anuncios = new Map(); // `${connectionId}|${id}` -> { status, rejectionReason, payload }
const chamadas = new Map(); // connectionId -> [{ op, externalId }]
const porChave = new Map(); // `${connectionId}|${chave}` -> id do anúncio
const fora = new Set(); // connectionId com o portal fora do ar
const ignorarRemocao = new Map(); // connectionId -> quantas remoções ainda respondem 200 sem remover

const chave = (connectionId, externalId) => `${connectionId}|${externalId}`;

function erroHttp(status, mensagem) { return Object.assign(new Error(mensagem), { status, statusCode: status }); }

function registrar(connectionId, op, externalId = null) {
  if (!chamadas.has(connectionId)) chamadas.set(connectionId, []);
  chamadas.get(connectionId).push({ op, externalId });
}

function assertUp(connectionId) {
  if (fora.has(connectionId)) throw Object.assign(new Error('O portal está fora do ar.'), { code: 'ECONNREFUSED' });
}

module.exports = {
  erroHttp,
  assertUp,
  registrar,
  salvar: (connectionId, externalId, dados) => anuncios.set(chave(connectionId, externalId), { rejectionReason: null, ...dados }),
  achar: (connectionId, externalId) => anuncios.get(chave(connectionId, externalId)) || null,
  lembrarChave: (connectionId, k, externalId) => porChave.set(chave(connectionId, k), externalId),
  idPorChave: (connectionId, k) => porChave.get(chave(connectionId, k)) || null,
  /** Chamadas feitas ao portal da connection (para provar "0 chamadas"). */
  calls: (connectionId) => [...(chamadas.get(connectionId) || [])],
  /** O que o portal guardou do anúncio (campos já no vocabulário do portal). */
  lastPayload: (connectionId, externalId) => { const a = anuncios.get(chave(connectionId, externalId)); return a ? a.payload : null; },
  /** O portal muda o estado do anúncio por conta própria (reprovou, removeu). */
  setStatus: (connectionId, externalId, status, rejectionReason = null) => {
    const a = anuncios.get(chave(connectionId, externalId));
    if (a) Object.assign(a, { status, rejectionReason });
  },
  setDown: (connectionId, desligado) => { if (desligado) fora.add(connectionId); else fora.delete(connectionId); },
  isDown: (connectionId) => fora.has(connectionId),
  /** As próximas `n` remoções respondem 200 mas o anúncio continua no ar. */
  ignoreUnpublishNext: (connectionId, n) => ignorarRemocao.set(connectionId, n),
  consumeIgnoreUnpublish: (connectionId) => {
    const n = ignorarRemocao.get(connectionId) || 0;
    if (n > 0) ignorarRemocao.set(connectionId, n - 1);
    return n > 0;
  },
  reset: () => { anuncios.clear(); chamadas.clear(); porChave.clear(); fora.clear(); ignorarRemocao.clear(); },
};
