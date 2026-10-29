'use strict';

// M9-D021 — defesa final da saída: URL ou e-mail que não estava nas fontes autorizadas nem na entrada do usuário, e marcação de
// imagem com query (canal clássico de exfiltração), são removidos da resposta. A remoção vira detecção para o evento.
// Independe do que o modelo "decidiu": roda sempre sobre o texto pronto.

const crypto = require('node:crypto');
const { maskSecrets } = require('../guards/secretPatterns');
const { normalizeText } = require('../security/textNormalizer');
const { EXCERPT_MAX } = require('./injectionDetector');

const ORIGEM_SAIDA = 'MODEL_OUTPUT';
const ID_SAIDA = 'model-output';
const IMAGEM_COM_QUERY = /!\[[^\]]*\]\(\s*[^)\s]*\?[^)]*\)|<img\b[^>]*\bsrc\s*=\s*["']?[^"'>\s]*\?[^>]*>/gi;
const URL = /\bhttps?:\/\/[^\s<>()[\]"'`]+|\bwww\.[^\s<>()[\]"'`]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PONTUACAO_FINAL = /[.,;:!?]+$/;
const TROCAS = Object.freeze({ IMAGE_QUERY: '[imagem removida]', URL: '[link removido]', EMAIL: '[e-mail removido]' });
const PADRAO_POR_TIPO = Object.freeze({ IMAGE_QUERY: 'SAIDA_IMAGEM_COM_QUERY', URL: 'SAIDA_URL_NAO_AUTORIZADA', EMAIL: 'SAIDA_EMAIL_NAO_AUTORIZADO' });

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const minusculo = (t) => String(t).toLowerCase();

function autorizado(valor, corpus) {
  const v = minusculo(valor).replace(PONTUACAO_FINAL, '');
  return corpus.includes(v) || corpus.includes(v.replace(/\/$/, ''));
}

/**
 * `sanitizeOutput(texto, { authorizedTexts, userInput })` => { text, changed, removed: [{kind, hash}], detections }.
 * `authorizedTexts` são os textos das fontes que ENTRARAM no contexto (trecho em quarentena não conta).
 */
function sanitizeOutput(texto, { authorizedTexts = [], userInput = '' } = {}) {
  const original = String(texto === null || texto === undefined ? '' : texto);
  const corpus = minusculo([...authorizedTexts, userInput].join('\n'));
  const removed = [];
  const valores = [];
  const trocar = (kind, regex, deveRemover) => (m) => {
    const valor = kind === 'URL' ? m.replace(PONTUACAO_FINAL, '') : m;
    if (!deveRemover(valor)) return m;
    removed.push({ kind, hash: sha(valor) });
    valores.push(valor);
    return TROCAS[kind] + (kind === 'URL' ? m.slice(valor.length) : '');
  };
  let saida = original.replace(IMAGEM_COM_QUERY, trocar('IMAGE_QUERY', null, () => true));
  saida = saida.replace(URL, trocar('URL', null, (v) => !autorizado(v, corpus)));
  saida = saida.replace(EMAIL, trocar('EMAIL', null, (v) => !autorizado(v, corpus)));
  const tipos = [...new Set(removed.map((r) => r.kind))];
  const detections = removed.length ? [{
    sourceId: ID_SAIDA, origin: ORIGEM_SAIDA, action: 'OUTPUT_SANITIZED', patternIds: tipos.map((t) => PADRAO_POR_TIPO[t]), score: null,
    contentHash: sha(original), excerpt: maskSecrets(valores[0]).slice(0, EXCERPT_MAX),
  }] : [];
  return { text: saida, changed: removed.length > 0, removed, detections, normalizedLength: normalizeText(saida).length };
}

module.exports = { sanitizeOutput, ORIGEM_SAIDA, ID_SAIDA };
