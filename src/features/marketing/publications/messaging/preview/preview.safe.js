'use strict';

const { mktError } = require('../../../marketing.errors');
const { detect } = require('./preview.patterns');

const REDACTED = '[REDIGIDO]';

/**
 * previewSafe(text, config, { maxChars }) — M9-D429 regra 5. Acha os 8 padrões sensíveis cujo começo está no trecho que aparece na notificação (os
 * `maxChars` primeiros caracteres; sem `maxChars`, o texto inteiro, como no assunto e no pré-cabeçalho do e-mail). Trecho (CPF, CNPJ, contrato, endereço)
 * vira [REDIGIDO]; frase sensível (dívida, saldo, restrição, saúde) não se redige: `refused = true` e o chamador recusa (MKT_PREVIEW_SENSITIVE) ou usa o
 * texto seguro. Devolve { safe, refused, text, patterns } com `text` já redigido quando for possível (null quando recusado).
 */
function previewSafe(text, config, { maxChars } = {}) {
  const source = String(text === undefined || text === null ? '' : text);
  const inPreview = detect(source, config).filter((f) => maxChars === undefined || f.start < maxChars);
  if (inPreview.length === 0) return { safe: true, refused: false, text: source, patterns: [] };
  const patterns = [...new Set(inPreview.map((f) => f.pattern))];
  if (inPreview.some((f) => f.scope === 'SENTENCE')) return { safe: false, refused: true, text: null, patterns };
  let redacted = source;
  let cursor = Infinity;
  for (const f of [...inPreview].sort((a, b) => b.start - a.start)) {
    if (f.end > cursor) continue; // achados sobrepostos: já coberto pelo trecho de trás
    redacted = `${redacted.slice(0, f.start)}${REDACTED}${redacted.slice(f.end)}`;
    cursor = f.start;
  }
  return { safe: false, refused: false, text: redacted, patterns };
}

const previewSensitive = (details) => mktError(422, 'MKT_PREVIEW_SENSITIVE', 'A mensagem revelaria informação sensível na pré-visualização.', details);

module.exports = { previewSafe, previewSensitive, REDACTED };
