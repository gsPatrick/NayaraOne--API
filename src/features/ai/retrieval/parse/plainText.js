'use strict';

/** Texto simples (TXT, Markdown, CSV): UTF-8 sem BOM e sem caracteres de controle. Binário disfarçado de texto é ilegível. */
const BOM = 0xfeff;
const isControl = (c) => (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127;

function parsePlainText(buffer) {
  const bruto = buffer.toString('utf8');
  const chars = Array.from(bruto).filter((ch, i) => !(i === 0 && ch.codePointAt(0) === BOM));
  const controles = chars.filter((ch) => isControl(ch.codePointAt(0))).length;
  if (chars.length && controles / chars.length > 0.01) throw Object.assign(new Error('TEXT_UNREADABLE'), { code: 'TEXT_UNREADABLE' });
  const limpo = chars.filter((ch) => !isControl(ch.codePointAt(0))).join('').replace(/\r\n?/g, '\n');
  return { text: limpo.trim(), activeDiscarded: 0 };
}

module.exports = { parsePlainText };
