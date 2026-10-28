'use strict';

const { nayUnavailable } = require('./pipeline.errors');

/**
 * M9-D406 — Porta do agente NAY de conteúdo (bloco A). A NAY recebe SOMENTE os fatos do read model público; devolve texto, o id da
 * execução (run) e o nome do modelo (M9-D405). Quem entrega o provider (sandbox ou real) registra aqui; sem provider, ou com o
 * provider em falha, o conteúdo fica DRAFT com MKT_NAY_UNAVAILABLE e pode ser escrito à mão.
 */
let provider = null;

function registerNayDraftProvider(fn) {
  if (typeof fn !== 'function') throw new TypeError('O provider da NAY deve ser uma função.');
  provider = fn;
}

function clearNayDraftProvider() {
  provider = null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requestDraft({ facts, contentType, brandContext }) {
  if (!provider) throw nayUnavailable({ reason: 'NO_PROVIDER' });
  let out;
  try {
    out = await provider({ facts, contentType, brandContext });
  } catch (err) {
    throw nayUnavailable({ reason: 'PROVIDER_ERROR' });
  }
  const valid = out && typeof out.text === 'string' && out.text.trim() && typeof out.nayRunId === 'string' && UUID.test(out.nayRunId)
    && typeof out.modelName === 'string' && out.modelName.trim();
  if (!valid) throw nayUnavailable({ reason: 'INVALID_RESPONSE' });
  return { text: out.text.trim(), nayRunId: out.nayRunId, modelName: out.modelName.trim() };
}

module.exports = { registerNayDraftProvider, clearNayDraftProvider, requestDraft };
