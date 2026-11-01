'use strict';

/**
 * Normalização do texto antes da extração de URL (M9-D433, reabertura da rodada 4). Cada passo é linear (sem regex com retrocesso):
 * 1. decodifica UMA vez %xx e as entidades HTML de pontuação e de letra ("evil.com%2Flogin", "evil&#46;com", "&period;");
 * 2. NFKC (largura total, reticências e variantes viram o caractere comum);
 * 3. tira invisíveis e controles (todo caractere de formato Unicode: largura zero, bidi, soft hyphen, BOM, tags; seletores de variação; preenchimentos Hangul e braille vazio);
 * 4. troca o ponto ideográfico e variantes por ponto.
 */
const PERCENT = /%([0-9a-f]{2})/gi;
const ENTITY = /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|period|sol|bsol|colon|commat|num|quest|lt|gt|quot|apos|lowbar|hyphen|dash|excl|lpar|rpar|comma|semi));/gi;
const NAMED = { amp: '&', period: '.', sol: '/', bsol: '\\', colon: ':', commat: '@', num: '#', quest: '?', lt: '<', gt: '>', quot: '"', apos: "'", lowbar: '_', hyphen: '-', dash: '-', excl: '!', lpar: '(', rpar: ')', comma: ',', semi: ';' };
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u180E\u3164\uFFA0\u2800\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu; // eslint-disable-line no-misleading-character-class
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g; // eslint-disable-line no-control-regex
const IDEOGRAPHIC_DOTS = /[\u3002\uFF0E\uFF61\u2024]/g; // ponto ideográfico, largura total, meia largura e leader

const fromCode = (code) => (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '');

function normalizeForUrls(text) {
  return String(text)
    .replace(PERCENT, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(ENTITY, (_, dec, hex, name) => (name ? NAMED[name.toLowerCase()] : fromCode(dec ? Number(dec) : parseInt(hex, 16))))
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROLS, '')
    .replace(IDEOGRAPHIC_DOTS, '.');
}

module.exports = { normalizeForUrls };
