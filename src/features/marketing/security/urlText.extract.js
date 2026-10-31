'use strict';

const { DEFAULT_TLDS } = require('./url.settings');

/**
 * Extração das URLs escritas num texto (M9-D433). O texto termina a URL em espaço, aspas, parêntese ou colchete; pontuação final não faz parte dela.
 * O texto é normalizado antes (NFKC: largura total vira normal; ponto ideográfico e invisíveis somem), e reconhece, nesta ordem: (1) qualquer esquema seguido de "/"
 * ou "\" (https://, ftp://, file://, https:/x, https:\\x); (2) esquemas de código e http(s): sem barra (javascript:, data:, https:evil.com); (3) esquema relativo (//host);
 * (4) www.; (5) IP nu (1.2.3.4/x) e credencial sem esquema (a@evil.com/x); (6) domínio com CAMINHO (rótulo.rótulo/, ?, #) com qualquer terminação, inclusive IDN e punycode ("evil.fr/login"); (7) domínio solto SEM
 * caminho cuja terminação está em `marketing.url.tlds_reconhecidos`. Não são URL: e-mail (parte local antes do @), palavra colada a outra depois do ponto
 * ("nota.de.venda") nem terminação em Maiúscula+minúsculas sem caminho ("Obrigado.Me", "Nayara.One": fim de frase sem espaço).
 */
const TAIL = '[^\\s<>"\'`)\\]}]';
const LB = '(?<![\\p{L}\\p{N}_@./:\\\\-])';
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const SCHEME_SLASH = new RegExp(`\\b[a-z][a-z0-9+.-]{1,19}:[/\\\\]${TAIL}*`, 'giu');
const CODE_SCHEME = new RegExp(`\\b(?:javascript|data|vbscript|blob|about|https?):(?![/\\\\])${TAIL}+`, 'giu');
const SCHEME_RELATIVE = new RegExp(`(?<![\\p{L}\\p{N}_:/\\\\.@-])(?:\\/\\/|\\\\\\\\)[\\p{L}\\p{N}]${TAIL}*`, 'giu');
const WWW = new RegExp(`${LB}www\\.${TAIL}+`, 'giu');
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const BARE_IP = new RegExp(`${LB}(?:${OCTET}\\.){3}${OCTET}(?![\\p{L}\\p{N}-])(?!\\.[\\p{L}\\p{N}])(?:[:/?#]${TAIL}*)?`, 'giu');
const GENERIC_TLD = '(?:xn--[a-z0-9-]{2,59}|\\p{L}{2,24})';
const DOMAIN_WITH_PATH = new RegExp(`${LB}(?:${LABEL}\\.)+${GENERIC_TLD}(?![\\p{L}\\p{N}-])(?!@)(?=[/?#])${TAIL}*`, 'giu');
const USERINFO_PATH = new RegExp(`${LB}[\\p{L}\\p{N}._-]+@(?:${LABEL}\\.)+${GENERIC_TLD}(?![\\p{L}\\p{N}-])(?=[/?#])${TAIL}*`, 'giu'); // nayara.com.br@evil.com/x: o truque da credencial na URL
const TRAILING = /[.,;:!?]+$/;
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const IDEOGRAPHIC_DOTS = /[。．｡․]/g;
const TITLE_CASE = /^\p{Lu}\p{Ll}+$/u;

const bareDomain = (tlds) => new RegExp(`${LB}(?:${LABEL}\\.)+(?:${tlds.join('|')})(?![\\p{L}\\p{N}-])(?!\\.[\\p{L}\\p{N}])(?!@)(?:[/:?#]${TAIL}*)?`, 'giu');

/** Texto normalizado para a conferência de URL (o que o leitor vê como endereço, não os caracteres que o escondem). */
const normalizeForUrls = (text) => String(text).replace(INVISIBLE, '').normalize('NFKC').replace(IDEOGRAPHIC_DOTS, '.');

/** "Obrigado.Me" / "Nayara.One": sem caminho e com a terminação em Maiúscula+minúsculas é fim de frase sem espaço, não endereço. */
function isGluedSentence(match) {
  if (/[/?#:]/.test(match)) return false;
  return TITLE_CASE.test(match.slice(match.lastIndexOf('.') + 1));
}

/** Passa o texto por cada padrão em ordem; devolve { found, rest } (rest = texto com os trechos achados trocados por espaços). */
function scan(text, config = {}) {
  const tlds = Array.isArray(config.tlds) && config.tlds.length > 0 ? config.tlds : DEFAULT_TLDS;
  let rest = normalizeForUrls(text);
  const found = [];
  const patterns = [SCHEME_SLASH, CODE_SCHEME, SCHEME_RELATIVE, WWW, BARE_IP, USERINFO_PATH, DOMAIN_WITH_PATH, bareDomain(tlds)];
  for (const re of patterns) {
    rest = rest.replace(re, (match) => {
      if (isGluedSentence(match)) return match;
      found.push(match.replace(TRAILING, ''));
      return ' '.repeat(match.length); // o trecho achado sai do texto: os padrões seguintes não o contam de novo
    });
  }
  return { found: [...new Set(found.filter(Boolean))], rest };
}

function extractUrls(text, config) {
  if (typeof text !== 'string') return [];
  return scan(text, config).found;
}

/** O texto (normalizado) sem as URLs, para as conferências que não devem tratar o número de um endereço como afirmação. */
function stripUrls(text, config) {
  if (typeof text !== 'string') return '';
  return scan(text, config).rest;
}

module.exports = { extractUrls, stripUrls, normalizeForUrls };
