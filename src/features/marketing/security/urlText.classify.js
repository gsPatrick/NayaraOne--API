'use strict';

const net = require('node:net');
const { domainToUnicode } = require('node:url');
const { DEFAULT_TLDS, DEFAULT_FILE_EXTENSIONS, DEFAULT_SHORTENERS } = require('./url.settings');

/**
 * Classificação de uma sequência com forma de endereço (M9-D433, reabertura da rodada 4). Devolve 'HOSTILE' (bloqueia), 'REVIEW' (vai à aprovação humana, nunca à
 * autopublicação) ou null (não é endereço: número, data, CNPJ, versão).
 *  - Número com pontos e barras NÃO é domínio (última parte não alfabética) nem IP: "CNPJ 12.345.678/0001-90", "Decreto 10.123/19", "Processo 12.345.678/9", "1.500/mês".
 *  - IP de 4 grupos decimais, decimal longo, hexadecimal e octal são endereço; a forma curta (127.1/x) só quando aponta para a própria máquina.
 *  - As listas de terminações e de encurtadores configuradas SOMAM à base: o administrador acrescenta, nunca afrouxa abaixo dela. A de extensões de arquivo é a configurada (reduzir só endurece).
 */
const TLD_SHAPE = /^(?:xn--[a-z0-9-]{2,59}|\p{L}[\p{L}\p{M}]{1,23})$/iu; // com marcas combinantes (.भारत, .বাংলা)
const THOUSANDS = /^\d{1,3}(?:\.\d{3})+$/;
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IP4 = new RegExp(`^(?:${OCTET}\\.){3}${OCTET}$`);
const NUMERIC_SHAPE = /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i;
const ABBREVIATION = /^\p{Lu}\p{L}{0,2}$/u;
const TITLE_WORD = /^\p{Lu}\p{Ll}+$/u; // "Compre.Agora": duas palavras coladas depois do ponto final, sem espaço
const GLUED_TAIL = /^(?:\/[\p{Lu}\d][\p{L}\p{N}.]*)+\/?$/u; // "/SP", "/Centro", "/100", "/Sra.Souza"

const PRIVATE = new net.BlockList();
for (const [net4, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10], ['224.0.0.0', 3]]) PRIVATE.addSubnet(net4, bits);
PRIVATE.addAddress('0.0.0.0');

const union = (base, extra) => new Set([...(base || []), ...(extra || [])].map((t) => String(t).toLowerCase()));
const cache = new WeakMap(); // listas prontas por configuração (a varredura de um texto grande chama a classificação muitas vezes)
function listsOf(config) {
  if (!cache.has(config)) {
    const shorteners = [...union(DEFAULT_SHORTENERS, config.shorteners)];
    cache.set(config, { shorteners, known: union(DEFAULT_TLDS, config.tlds), extensions: union(config.fileExtensions && config.fileExtensions.length ? config.fileExtensions : DEFAULT_FILE_EXTENSIONS), shortenerSet: new Set(shorteners) });
  }
  return cache.get(config);
}

/**
 * Forma numérica (só dígitos, hexadecimal e pontos). Número comum NUNCA é endereço nem bloqueia por heurística numérica (M9-D433, rodada 5): separador de milhar
 * ("R$ 2.000/mês", "IPTU 1.045/ano", "CNPJ 12.345.678/0001-90") e fração ("0.5/1", "Art. 10.2/3") ficam de fora, e a regra do octal por "zero à esquerda" não existe mais.
 * Só é HOSTILE o que é inequivocamente um IP escrito de outra forma: hexadecimal inteiro (0x7f000001), hexadecimal por grupo, a própria máquina em forma curta (127.1/x),
 * decimal longo ou octal de 4 grupos que resolvem para a própria máquina ou rede privada.
 */
function numericKind(head, tail) {
  if (THOUSANDS.test(head)) return null; // 2.000, 10.000, 1.045, 12.345.678: separador de milhar
  let host = null;
  try { host = new URL(`http://${head}`).hostname; } catch (err) { return null; }
  if (!net.isIPv4(host)) return null; // 2020.123 não é endereço (grupo acima de 255 fora do último)
  const hasPath = /^[/?#]/.test(tail);
  const labels = head.split('.');
  if (labels.some((l) => /^0x/i.test(l))) return hasPath || /^0x[0-9a-f]{6,8}$/i.test(head) ? 'HOSTILE' : null;
  const loopback = /^127\./.test(host) || host === '0.0.0.0';
  if (labels.length === 1) return /^\d{7,10}$/.test(head) && PRIVATE.check(host) ? 'HOSTILE' : null; // inteiro único (2130706433), com ou sem caminho
  if (labels.length === 4 && labels.some((l) => /^0\d/.test(l))) return PRIVATE.check(host) ? 'HOSTILE' : null; // octal de 4 grupos (0177.0.0.1)
  return hasPath && loopback ? 'HOSTILE' : null; // forma curta (127.1/x) só quando é a própria máquina
}

function domainKind(head, tail, config) {
  const labels = head.split('.');
  const lowerHead = head.toLowerCase();
  const tld = labels[labels.length - 1].toLowerCase();
  const { shorteners, known, extensions } = listsOf(config);
  if (shorteners.some((s) => lowerHead === s || lowerHead.endsWith(`.${s}`)) || /^www\./.test(lowerHead)) return 'HOSTILE';
  if (extensions.has(tld) && tail === '') return 'REVIEW'; // nome de arquivo (foto.jpg, arquivo.zip): parâmetro marketing.url.extensoes_arquivo
  if (known.has(tld) || (tld.startsWith('xn--') && known.has(domainToUnicode(tld)))) return 'HOSTILE'; // terminação conhecida, em Unicode ou punycode
  if (ABBREVIATION.test(labels[0]) && (tail === '' || GLUED_TAIL.test(tail))) return 'REVIEW';
  if (tail === '' && labels.every((l) => TITLE_WORD.test(l))) return 'REVIEW';
  // Terminação fora da lista (Trav.das, p.ex, Sala.Comercial/Térreo, evil.zzzz/login): ambíguo, uma pessoa vê; nunca bloqueia por heurística (rodada 5).
  return 'REVIEW';
}

/** `head` = a sequência de caracteres de domínio (letras, dígitos, hífen, ponto); `tail` = porta, caminho e consulta que a seguem. */
function classify(head, tail, config) {
  if (IP4.test(head)) return 'HOSTILE';
  if (NUMERIC_SHAPE.test(head)) return numericKind(head, tail);
  const labels = head.split('.');
  if (labels.length < 2 || !TLD_SHAPE.test(labels[labels.length - 1])) return null;
  return domainKind(head, tail, config);
}

const isDomainShape = (head) => { const labels = head.split('.'); return labels.length >= 2 && (TLD_SHAPE.test(labels[labels.length - 1]) || IP4.test(head)); };

module.exports = { classify, isDomainShape, IP4 };
