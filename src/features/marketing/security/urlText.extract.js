'use strict';

const net = require('node:net');
const { DEFAULT_TLDS, DEFAULT_FILE_EXTENSIONS } = require('./url.settings');

/**
 * Extração das URLs escritas num texto (M9-D433), por REGRA DE DESENHO e não por lista de exceções (DI-D433-9).
 * 1. Normaliza: NFKC (largura total vira normal, "…" vira "..."), tira invisíveis e troca o ponto ideográfico por ponto.
 * 2. Esquemas: qualquer esquema seguido de "/" ou "\", esquemas de código e de contato sem barra (javascript:, data:, mailto:, sms:, tel:, https:evil.com), "//host" e a credencial
 *    na URL ("nayara.com.br@evil.com/x", "usuario:senha@host") são candidatos, sempre conferidos.
 * 3. O resto vira "fichas": separa por espaço e pelos separadores que se colam a um endereço (: _ ( ) [ ] < > aspas vírgula ponto e vírgula | ! * = e reticências); a barra, o
 *    "?" e o "#" ficam na ficha. Ficha cujo começo não é domínio ("link/evil.com/x") perde esse começo até o próximo "/". Ficha com forma de domínio (rótulos separados por ponto e
 *    terminação alfabética de 2+ letras, inclusive IDN e punycode, em qualquer caixa) é candidata, com ou sem caminho, www. ou porta, sem lista fechada. IP em decimal, octal,
 *    hexadecimal ou curto com caminho também.
 * 4. Só o que é provadamente texto comum NÃO é URL: e-mail (parte local antes do @) e menção "@nome" sem caminho. Candidatos de baixo risco são marcados REVIEW (não bloqueiam,
 *    vão à aprovação humana com finding): abreviação ("Av.Paulista", "Sr.Silva", "S.Paulo/SP": primeira palavra com maiúscula e até 3 letras, terminação fora da lista de
 *    terminações conhecidas e sem caminho minúsculo) e nome de arquivo ("foto.jpg", extensão da lista de extensões e fora da lista de terminações). O resto é HOSTILE.
 */
const TAIL = '[^\\s<>"\'`)\\]}]';
const SCHEME_SLASH = new RegExp(`\\b[a-z][a-z0-9+.-]{1,19}:[/\\\\]${TAIL}*`, 'giu');
const CODE_SCHEME = new RegExp(`\\b(?:javascript|data|vbscript|blob|about|mailto|sms|smsto|tel|callto|facetime|https?):(?![/\\\\])${TAIL}+`, 'giu');
const SCHEME_RELATIVE = new RegExp(`(?<![\\p{L}\\p{N}_:/\\\\.@-])(?:\\/\\/|\\\\\\\\)[\\p{L}\\p{N}]${TAIL}*`, 'giu');
const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?';
const GENERIC_TLD = '(?:xn--[a-z0-9-]{2,59}|\\p{L}{2,24})';
const USERINFO_PATH = new RegExp(`(?<![\\p{L}\\p{N}_@.-])[\\p{L}\\p{N}._%+-]+@(?:${LABEL}\\.)+${GENERIC_TLD}(?![\\p{L}\\p{N}-])(?=[/?#])${TAIL}*`, 'giu');
const USERINFO_PASSWORD = new RegExp(`(?<![\\p{L}\\p{N}_@.-])[\\p{L}\\p{N}._%+-]+:[^\\s@/]+@(?:${LABEL}\\.)+${GENERIC_TLD}(?![\\p{L}\\p{N}-])${TAIL}*`, 'giu');
const DOMAIN = new RegExp(`^(?:${LABEL}\\.)+${GENERIC_TLD}$`, 'iu');
const SEPARATORS = /[\s:_()[\]<>"'`“”‘’«»,;|!*=\\]+/u;
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
const IDEOGRAPHIC_DOTS = /[。．｡․]/g;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IP4 = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}$`);
const IP_ODD = /^(?:\d{7,10}|0x[0-9a-f]{1,8}|(?:0[0-7]*|\d+|0x[0-9a-f]+)(?:\.(?:0[0-7]*|\d+|0x[0-9a-f]+)){1,3})$/i; // decimal longo, hexadecimal, octal e forma curta (127.1)
const ABBREVIATION = /^\p{Lu}\p{L}{0,2}$/u;
const GLUED_TAIL = /^(?:\/[\p{Lu}\d][\p{L}\p{N}.]*)+\/?$/u; // "/SP", "/Centro", "/100", "/Sra.Souza": palavra com maiúscula ou número, sem "?" nem "#"

/** Texto normalizado para a conferência de URL (o que o leitor vê como endereço, não os caracteres que o escondem). */
const normalizeForUrls = (text) => String(text).replace(INVISIBLE, '').normalize('NFKC').replace(IDEOGRAPHIC_DOTS, '.');

const lower = (list) => new Set((list || []).map((t) => String(t).toLowerCase()));

function classifyDomain(head, tail, config) {
  const labels = head.split('.');
  const tld = labels[labels.length - 1].toLowerCase();
  const tlds = lower(config.tlds && config.tlds.length ? config.tlds : DEFAULT_TLDS);
  const extensions = lower(config.fileExtensions && config.fileExtensions.length ? config.fileExtensions : DEFAULT_FILE_EXTENSIONS);
  const shortener = (config.shorteners || []).some((s) => head.toLowerCase() === s || head.toLowerCase().endsWith(`.${s}`));
  if (shortener || /^www\./i.test(head) || tlds.has(tld)) return 'HOSTILE';
  if (ABBREVIATION.test(labels[0]) && labels.length >= 2 && (tail === '' || GLUED_TAIL.test(tail))) return 'REVIEW';
  if (extensions.has(tld) && tail === '') return 'REVIEW';
  return 'HOSTILE';
}

const PRIVATE = new net.BlockList();
for (const [net4, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10], ['224.0.0.0', 3]]) PRIVATE.addSubnet(net4, bits);
PRIVATE.addAddress('0.0.0.0');

/** IP em forma estranha: decimal longo e hexadecimal são sempre HOSTILE; a forma curta (127.1, 1.500/mês) só se normaliza para rede interna ou multicast; senão é número (REVIEW). */
function oddIpKind(head) {
  if (!head.includes('.')) return 'HOSTILE';
  let host = null;
  try { host = new URL(`http://${head}`).hostname; } catch (err) { return 'HOSTILE'; }
  return net.isIPv4(host) && !PRIVATE.check(host) ? 'REVIEW' : 'HOSTILE';
}

/** Candidatos de UMA ficha: [{ url, kind }]. Pode devolver mais de um (partes separadas por reticências) e nenhum (texto comum). */
function fromToken(raw, config, depth = 0) {
  let tok = raw.replace(/^[^\p{L}\p{N}@/]+/u, '').replace(/[.,;!?-]+$/u, '');
  if (!tok || depth > 6) return [];
  if (/\.{2,}/.test(tok)) return tok.split(/\.{2,}/).flatMap((part) => fromToken(part, config, depth + 1));
  if (tok.startsWith('@')) {
    const mention = tok.slice(1);
    return /[/?#]/.test(mention) ? fromToken(mention, config, depth + 1).map((c) => ({ ...c, kind: 'HOSTILE' })) : [];
  }
  if (tok.includes('@')) return []; // e-mail: parte local antes do @ (a credencial na URL já saiu na etapa dos esquemas)
  tok = tok.replace(/^\/+/, '');
  const head = tok.split(/[/?#]/)[0];
  const tail = tok.slice(head.length);
  if (DOMAIN.test(head)) return [{ url: tok, kind: classifyDomain(head, tail, config) }];
  if (IP4.test(head)) return [{ url: tok, kind: 'HOSTILE' }];
  if (IP_ODD.test(head) && /^[/?#]/.test(tail)) return [{ url: tok, kind: oddIpKind(head) }]; // decimal, octal, hexadecimal e curto só com caminho (3.14 e 1.000 são números)
  const slash = tok.indexOf('/');
  if (slash > 0 && !head.includes('.')) return fromToken(tok.slice(slash + 1), config, depth + 1); // "link/evil.com/x": o começo colado sai
  return [];
}

/** { found: [{ url, kind }], rest } (rest = o texto normalizado com cada trecho achado trocado por espaços). */
function scan(text, config = {}) {
  let rest = normalizeForUrls(text);
  const found = [];
  const blank = (match) => { found.push({ url: match.replace(/[.,;:!?]+$/, ''), kind: 'HOSTILE' }); return ' '.repeat(match.length); };
  for (const re of [SCHEME_SLASH, CODE_SCHEME, SCHEME_RELATIVE, USERINFO_PASSWORD, USERINFO_PATH]) rest = rest.replace(re, blank);
  const parts = rest.split(new RegExp(`(${SEPARATORS.source})`, 'u'));
  rest = parts.map((part) => {
    if (!part) return part;
    const hits = fromToken(part, config);
    if (hits.length === 0) return part;
    found.push(...hits);
    return ' '.repeat(part.length);
  }).join('');
  const seen = new Set();
  return { found: found.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url)), rest };
}

/** Todas as URLs achadas (bloqueáveis e de revisão) como texto, na ordem de aparição. */
function extractUrls(text, config) {
  return typeof text === 'string' ? scan(text, config).found.map((c) => c.url) : [];
}

/** [{ url, kind: 'HOSTILE' | 'REVIEW' }] */
function extractCandidates(text, config) {
  return typeof text === 'string' ? scan(text, config).found : [];
}

/** O texto (normalizado) sem as URLs, para as conferências que não devem tratar o número de um endereço como afirmação. */
function stripUrls(text, config) {
  return typeof text === 'string' ? scan(text, config).rest : '';
}

module.exports = { extractUrls, extractCandidates, stripUrls, normalizeForUrls };
