'use strict';

/**
 * Política de pacotes de integração (M9-D210 3.2 e M9-D248): o que é "SDK de fornecedor" e o que é biblioteca HTTP.
 * Funções puras, sem banco: o guarda de CI (scripts/checkIntegrationBoundaries.js) e o teste de arquitetura usam as
 * mesmas. A lista de SDKs é o parâmetro `integration.sdk.denylist` (padrão abaixo, INT-P095); a leitura por empresa está
 * em sdk.params.js.
 */
const DEFAULT_SDK_DENYLIST = Object.freeze(['twilio', '@sendgrid/mail', 'aws-sdk', '@aws-sdk/*', 'googleapis', 'stripe']);

/** Bibliotecas que falam HTTP por conta própria: proibidas em qualquer arquivo, o único caminho é o IntegrationHttpClient. */
const HTTP_LIBRARIES = Object.freeze(['axios', 'node-fetch', 'got', 'undici', 'superagent', 'needle', 'request']);

/** "a, b ,c" -> ['a','b','c']; ignora vazios e repetições. */
function parseList(text) {
  const itens = Array.isArray(text) ? text : String(text || '').split(',');
  return [...new Set(itens.map((i) => String(i).trim()).filter(Boolean))];
}

/** Nome do pacote npm de um especificador: '@aws-sdk/client-s3/dist' -> '@aws-sdk/client-s3'; relativo ou builtin -> null. */
function packageNameOf(spec) {
  if (typeof spec !== 'string' || !spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return null;
  const partes = spec.split('/');
  return spec.startsWith('@') ? partes.slice(0, 2).join('/') : partes[0];
}

/** Padrão 'twilio' (exato) ou '@aws-sdk/*' (prefixo) contra o especificador de um import. */
function matchesPattern(pattern, spec) {
  const nome = packageNameOf(spec);
  if (!nome) return false;
  if (pattern.endsWith('/*')) return nome.startsWith(pattern.slice(0, -1)) || nome === pattern.slice(0, -2);
  return nome === pattern;
}

const matchesAny = (patterns, spec) => patterns.some((p) => matchesPattern(p, spec));
const isSdkPackage = (spec, denylist = DEFAULT_SDK_DENYLIST) => matchesAny(denylist, spec);
const isHttpLibrary = (spec) => matchesAny(HTTP_LIBRARIES, spec);

module.exports = { DEFAULT_SDK_DENYLIST, HTTP_LIBRARIES, parseList, packageNameOf, matchesPattern, matchesAny, isSdkPackage, isHttpLibrary };
