'use strict';

const crypto = require('node:crypto');

/**
 * M9-D428 regra 3 — marca de idempotência. As redes não aceitam chave de idempotência, então o texto enviado leva uma marca curta derivada da chave do job; se a resposta
 * do post se perder, a reconciliação (M9-D411) procura a marca na rede em vez de publicar de novo. Dois modos pelo parâmetro: INVISIVEL (código em caracteres de largura
 * zero, não muda o que a pessoa lê) ou HASHTAG (hashtag técnica com o prefixo configurado). O código são 8 hexadecimais do SHA-256 da chave.
 */
const ZERO = '\u200b';
const ONE = '\u200c';
const CODE_LEN = 8;
const MODES = Object.freeze(['INVISIVEL', 'HASHTAG']);
const DEFAULT_PREFIX = 'nyr';

const codeOf = (key) => crypto.createHash('sha256').update(String(key), 'utf8').digest('hex').slice(0, CODE_LEN);
const encodeInvisible = (code) => [...code].map((c) => parseInt(c, 16).toString(2).padStart(4, '0')).join('').replace(/0/g, ZERO).replace(/1/g, ONE);
const decodeInvisible = (run) => {
  const bits = run.replace(new RegExp(ZERO, 'g'), '0').replace(new RegExp(ONE, 'g'), '1');
  return bits.match(/.{4}/g).map((b) => parseInt(b, 2).toString(16)).join('');
};

/** { code, mode, suffix }: `suffix` é o que se acrescenta ao fim do texto (e a conta de caracteres da legenda inclui). */
function watermarkFor(key, { mode = 'INVISIVEL', hashtagPrefix = DEFAULT_PREFIX } = {}) {
  const code = codeOf(key);
  const chosen = MODES.includes(mode) ? mode : 'INVISIVEL';
  return { code, mode: chosen, suffix: chosen === 'HASHTAG' ? ` #${hashtagPrefix}${code}` : encodeInvisible(code) };
}

/** Cópia do post com a marca no fim do texto (a legenda); post sem texto não ganha marca. */
function applyWatermark(post, watermark) {
  if (!post || typeof post.texto !== 'string') return post;
  return { ...post, texto: `${post.texto}${watermark.suffix}` };
}

/** O código da marca num texto (invisível ou hashtag com qualquer prefixo), ou null. */
function extractWatermarkCode(text) {
  const value = String(text || '');
  const invisible = new RegExp(`[${ZERO}${ONE}]{${CODE_LEN * 4}}$`).exec(value);
  if (invisible) return decodeInvisible(invisible[0]);
  const tag = new RegExp(`#[a-z0-9]*([0-9a-f]{${CODE_LEN}})$`).exec(value);
  return tag ? tag[1] : null;
}

module.exports = { watermarkFor, applyWatermark, extractWatermarkCode, codeOf, MODES, DEFAULT_PREFIX, CODE_LEN };
