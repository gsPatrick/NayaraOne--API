'use strict';

/**
 * Alvo de uma deprecação ou de um uso (M9-D841 §3.1): `ROUTE:<MÉTODO> <caminho com parâmetros>` ou `MAJOR:<n>`. O caminho é o do contrato OpenAPI (relativo à versão, sem
 * /api/v1) com parâmetros em chaves: `ROUTE:GET /people/{id}`. Quem informa `:id` (forma do Express) é normalizado para `{id}`. A major vem do prefixo /v<n> do caminho real.
 */
const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTE = /^ROUTE:([A-Za-z]+) (\/\S*)$/;
const MAJOR = /^MAJOR:(\d{1,4})$/;
const VERSIONED = /^\/v(\d{1,4})(\/.*)?$/;

function canonicalPath(path) {
  let out = path.replace(/^\/api\/v\d+(?=\/|$)/, '').replace(/^\/v\d+(?=\/)/, '').replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out || '/';
}

/** { kind, key, method?, path?, major? } ou null quando o texto não é um alvo. */
function parseTarget(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const major = MAJOR.exec(trimmed);
  if (major && Number(major[1]) >= 1) return { kind: 'MAJOR', key: `MAJOR:${Number(major[1])}`, major: Number(major[1]) };
  const route = ROUTE.exec(trimmed);
  if (!route || !METHODS.includes(route[1].toUpperCase()) || route[2].length > 280) return null;
  const method = route[1].toUpperCase();
  const path = canonicalPath(route[2]);
  return { kind: 'ROUTE', key: `ROUTE:${method} ${path}`, method, path };
}

/** Expressão que casa o caminho concreto (sem versão) com o caminho do alvo: `{x}` casa um segmento; maiúsculas não importam (como no Express). */
function pathMatcher(path) {
  const body = path.split('/').map((part) => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}/?$`, 'i');
}

/** Divide o caminho real da requisição (`/v1/people/123`) em major e caminho relativo; null fora do padrão versionado. */
function splitVersioned(requestPath) {
  const m = VERSIONED.exec(requestPath || '');
  return m ? { major: Number(m[1]), path: m[2] || '/' } : null;
}

const methodOf = (req) => (req.method === 'HEAD' ? 'GET' : req.method);

/** O alvo ROUTE da requisição já roteada (padrão do Express com parâmetros, ex.: `ROUTE:GET /people/{id}`); null se a rota não é texto ou não é versionada. */
function routeKeyOfRoutedRequest(req) {
  if (!req.route || typeof req.route.path !== 'string') return null;
  const split = splitVersioned(`${req.baseUrl || ''}${req.route.path}`.replace(/^\/api(?=\/v\d)/, ''));
  if (!split) return null;
  const method = methodOf(req);
  return METHODS.includes(method) ? `ROUTE:${method} ${canonicalPath(split.path)}` : null;
}

module.exports = { METHODS, parseTarget, canonicalPath, pathMatcher, splitVersioned, methodOf, routeKeyOfRoutedRequest };
