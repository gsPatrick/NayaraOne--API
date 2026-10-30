'use strict';

const { generateDraftWithNay } = require('../step.facts');

const PIECES = Object.freeze([{ field: 'roteiro', contentType: 'VIDEO_REEL_ROTEIRO' }, { field: 'descricao', contentType: 'VIDEO_REEL_DESCRICAO' }]);

/**
 * Roteiro e descrição do reel (M9-D426 regra 5). Informados à mão, valem como vieram; sem texto informado (modo NAY) a NAY escreve cada peça a partir SÓ dos fatos
 * (generateDraftWithNay, a mesma porta da legenda). NAY fora do ar não derruba o conteúdo: a peça fica ausente. Todas passam depois pelo validador factual e pela
 * limpeza de campos públicos, junto com a legenda.
 */
async function draftVideoCopy({ input, facts }) {
  const out = {};
  for (const { field, contentType } of PIECES) {
    if (typeof input[field] === 'string' && input[field].trim()) { out[field] = input[field].trim(); continue; }
    if (input.texto !== undefined) continue; // texto à mão: o resto também é à mão
    try {
      out[field] = (await generateDraftWithNay(facts, contentType, {})).text;
    } catch (err) {
      if (err.code !== 'MKT_NAY_UNAVAILABLE') throw err;
    }
  }
  return out;
}

/** Os textos do reel que saem para o público e passam pelo validador e pela limpeza: legenda, roteiro e descrição, nesta ordem. */
const videoTexts = (body) => [body.texto, body.roteiro, body.descricao].filter((t) => typeof t === 'string' && t.trim());

module.exports = { draftVideoCopy, videoTexts };
