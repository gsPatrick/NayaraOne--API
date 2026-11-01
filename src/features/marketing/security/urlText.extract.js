'use strict';

const { normalizeForUrls } = require('./urlText.normalize');
const { classify, isDomainShape } = require('./urlText.classify');
const { inDomains } = require('./urlRules');
const { trimTail, SENTENCE_PUNCTUATION } = require('./urlText.trim');

/**
 * Extração das URLs escritas num texto (M9-D433, DI-D433-9 e DI-D433-10): TOKENIZAÇÃO LINEAR, sem regex com retrocesso e sem lista de separadores.
 * 1. Normaliza (urlText.normalize): decodifica %xx e entidades, NFKC, tira invisíveis e controles.
 * 2. Esquemas: qualquer esquema seguido de "/" ou "\", esquemas de código e de contato sem barra (javascript:, data:, mailto:, sms:, tel:, https:evil.com) e "//host"
 *    são candidatos HOSTILE (cada regex tem tamanho de esquema limitado, então o custo é linear).
 * 3. Arroba: "usuario:senha@host", "dominio@host/caminho" e "@host/caminho" são candidatos; e-mail ("maria.pro@nayara.com.br") não é URL e fica fora da varredura.
 * 4. O resto: percorre o texto formando as MAIORES SEQUÊNCIAS de caracteres de domínio (letras e dígitos Unicode, hífen e ponto entre rótulos). QUALQUER outro caractere é
 *    fronteira, então nenhum separador precisa ser listado (Acesse–evil.com, evil.com{, ~evil.com, +evil.com valem como evil.com). A sequência com forma de domínio ou
 *    de IP é candidata, e porta, caminho e consulta que a seguem são lidos até espaço, aspas ou fecha-parênteses. A classificação é de urlText.classify.
 */
const TAIL = '[^\\s<>"\'`)\\]}]';
const SCHEME_SLASH = new RegExp(`\\b[a-z][a-z0-9+.-]{1,19}:[/\\\\]${TAIL}*`, 'giu');
const CODE_SCHEME = new RegExp(`\\b(?:javascript|data|vbscript|blob|about|mailto|sms|smsto|tel|callto|facetime|https?):(?![/\\\\])${TAIL}+`, 'giu');
const SCHEME_RELATIVE = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_:/\\\\.@-])(?:\\/\\/|\\\\\\\\)[\\p{L}\\p{N}\\p{M}\\[@]${TAIL}*`, 'giu');
// Um rótulo é lido em pedaços de no máximo 2000 caracteres: o motor de regex guarda uma entrada de pilha por repetição e estoura em texto de megabytes ("a" x 5.000.000).
const CHUNK_MAX = 2000;
const LABEL = new RegExp(`[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M}-]{0,${CHUNK_MAX - 1}}`, 'uy');
const LABEL_CONT = new RegExp(`[\\p{L}\\p{N}\\p{M}-]{1,${CHUNK_MAX}}`, 'uy');
const LABEL_START = /[\p{L}\p{N}]/gu;
const PORT = /:\d{1,5}(?![\p{L}\p{N}\p{M}])/uy;
const PATH = /[^\s<>"'`)\]}]*/uy;
const USER_BOUNDARY = /[\s<>"'`()[\]{},;|]/u;
const PATH_MARK = /[/?#]/;
const EMAIL_LOCAL = /^[\p{L}\p{N}._%+'-]*$/u;

const blankSpans = (text, spans) => {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [start, end] of sorted) { if (start >= at) { out += text.slice(at, start) + ' '.repeat(end - start); at = end; } }
  return out + text.slice(at);
};

const sticky = (re, text, at) => { re.lastIndex = at; const m = re.exec(text); return m ? m[0] : null; };

/** Tamanho do rótulo que começa em `at` (0 se não começa rótulo). */
function labelLength(text, at) {
  const first = sticky(LABEL, text, at);
  if (first === null) return 0;
  let total = first.length;
  let last = first.length;
  while (last === CHUNK_MAX) {
    const more = sticky(LABEL_CONT, text, at + total);
    if (more === null) break;
    total += more.length;
    last = more.length;
  }
  return total;
}

/** Sequência de domínio que começa em `at` (rótulos separados por um ponto), ou null. */
function readRun(text, at) {
  let end = at + labelLength(text, at);
  if (end === at) return null;
  while (text[end] === '.') {
    const next = labelLength(text, end + 1);
    if (next === 0) break;
    end += 1 + next;
  }
  return text.slice(at, end);
}

/** Todas as sequências de domínio do texto, na ordem: [{ index, head }]. Um passe só pelos rótulos. */
function* eachRun(text) {
  let pos = 0;
  let current = null;
  for (;;) {
    LABEL_START.lastIndex = pos;
    const m = LABEL_START.exec(text);
    if (m === null) break;
    const end = m.index + labelLength(text, m.index);
    pos = end;
    if (current !== null && m.index === current.end + 1 && text[current.end] === '.') { current.end = end; continue; }
    if (current !== null) yield { index: current.index, head: text.slice(current.index, current.end) };
    current = { index: m.index, end };
  }
  if (current !== null) yield { index: current.index, head: text.slice(current.index, current.end) };
}

/** Acrescenta um trecho à lista de trechos, juntando com o último quando encosta (evita milhões de trechos num texto de arrobas). */
function pushSpan(list, start, end) {
  const last = list[list.length - 1];
  if (last && start <= last[1]) { if (end > last[1]) last[1] = end; return; }
  list.push([start, end]);
}

/** Porta, caminho e consulta depois de uma sequência que termina em `end`. Devolve o índice final do endereço. */
function addressEnd(text, end) {
  let at = end;
  if (text[at] === '.' && '/?#'.includes(text[at + 1] || ' ')) at += 1; // "evil.com./login"
  const port = sticky(PORT, text, at);
  if (port) at += port.length;
  if ('/?#'.includes(text[at] || ' ')) at += sticky(PATH, text, at).length;
  return at;
}

/**
 * Passo do arroba: devolve { found, maskSpans, hostileSpans }. Cada trecho entre arrobas é lido uma vez e um arroba dentro de um endereço já lido é pulado (custo linear).
 * "evil.com/login@x" NÃO é e-mail: se antes do arroba há barra, interrogação ou cerquilha, o arroba está num caminho e a varredura de domínio lê o endereço inteiro (M-1).
 * "nayara.com.br@evil.com" (domínio da empresa ou da lista permitida no lugar do usuário, host de fora) é endereço disfarçado: HOSTILE.
 */
function atPass(text, config) {
  const found = [];
  const maskSpans = [];
  const hostileSpans = [];
  const allowed = config.allowedDomains || [];
  let previousAt = -1;
  let coveredTo = -1;
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
    let start = i;
    while (start > previousAt + 1 && !USER_BOUNDARY.test(text[start - 1])) start -= 1;
    previousAt = i;
    if (i < coveredTo) continue;
    const user = text.slice(start, i);
    if (PATH_MARK.test(user)) continue;
    const host = readRun(text, i + 1);
    const hostEnd = i + 1 + (host ? host.length : 0);
    const hostOk = Boolean(host) && isDomainShape(host);
    const disguised = user.length > 0 && isDomainShape(user) && inDomains(user.toLowerCase(), allowed) && !inDomains((host || '').toLowerCase(), allowed);
    if (!hostOk) {
      if (!disguised) { if (start < i) pushSpan(maskSpans, start, i + 1); continue; }
      found.push({ url: trimTail(text.slice(start, hostEnd)), kind: 'HOSTILE' });
      pushSpan(hostileSpans, start, hostEnd);
      pushSpan(maskSpans, start, hostEnd);
      continue;
    }
    const end = addressEnd(text, hostEnd);
    coveredTo = end;
    const hasPath = end > hostEnd && PATH_MARK.test(text.slice(hostEnd, end));
    const credential = user.includes(':');
    if (!hasPath && !credential && !disguised) { pushSpan(maskSpans, EMAIL_LOCAL.test(user) ? start : i, hostEnd); continue; } // e-mail
    const kind = credential && !hasPath && !user.slice(0, user.indexOf(':')).includes('.') && !/^\d+$/.test(user.slice(0, user.indexOf(':'))) ? 'REVIEW' : 'HOSTILE';
    found.push({ url: trimTail(user ? text.slice(start, end) : text.slice(i + 1, end)), kind });
    if (kind === 'HOSTILE') pushSpan(hostileSpans, start, end);
    pushSpan(maskSpans, start, end);
  }
  return { found, maskSpans, hostileSpans };
}

/** Passo das sequências de domínio sobre o texto já sem e-mails e sem o que o passo do arroba achou. */
function runPass(text, config) {
  const found = [];
  const spans = [];
  let skipUntil = 0;
  for (const { index, head } of eachRun(text)) {
    if (index < skipUntil) continue; // dentro do caminho de um endereço já lido
    const runEnd = index + head.length;
    // Só lê porta e caminho de quem já é endereço (o caminho é lido até o fim da ficha; fazer isso para cada sequência comum tornaria a varredura quadrática).
    if (!classify(head, '/', config)) continue;
    const end = addressEnd(text, runEnd);
    const kind = classify(head, text.slice(runEnd, end).replace(/^\./, ''), config);
    if (!kind) continue;
    found.push({ url: trimTail(text.slice(index, end)), kind });
    spans.push([index, end]);
    skipUntil = end;
  }
  return { found, spans };
}

/** { found: [{ url, kind }], rest } (rest = o texto normalizado com cada trecho achado trocado por espaços). */
function scan(text, config = {}) {
  let rest = normalizeForUrls(text);
  const found = [];
  const blank = (match) => { found.push({ url: trimTail(match, SENTENCE_PUNCTUATION), kind: 'HOSTILE' }); return ' '.repeat(match.length); };
  for (const re of [SCHEME_SLASH, CODE_SCHEME, SCHEME_RELATIVE]) rest = rest.replace(re, blank);
  const at = atPass(rest, config);
  for (const c of at.found) found.push(c);
  const scanText = blankSpans(rest, at.maskSpans);
  rest = blankSpans(rest, at.hostileSpans);
  const runs = runPass(scanText, config);
  for (const c of runs.found) found.push(c);
  const seen = new Set();
  return { found: found.filter((c) => c.url && !seen.has(c.url) && seen.add(c.url)), rest: blankSpans(rest, runs.spans) };
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
