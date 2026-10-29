'use strict';

/**
 * Escopo FECHADO do contrato (M9-D840 §3.1), no arquivo versionado openapi/escopo.json: `entries` é a lista de prefixos de caminho (sem /api/v1) e de rotas exatas ("MÉTODO /caminho").
 * Só rota que casa com o escopo é exigida no contrato; rota fora dele pode constar, mas não é cobrada.
 */
const shape = (path) => path.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}');
const normalizePath = (path) => shape(String(path).replace(/^\/api\/v\d+/, '').replace(/\/+$/, '') || '/');

function parseScope(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  if (!data || !Array.isArray(data.entries) || data.entries.some((entry) => typeof entry !== 'string' || !entry.trim())) throw new Error('escopo.json deve ter "entries": lista de textos');
  return data.entries.map((entry) => {
    const exact = /^([A-Z]+)\s+(\/\S*)$/.exec(entry.trim());
    return exact ? { method: exact[1], path: normalizePath(exact[2]) } : { prefix: normalizePath(entry.trim()) };
  });
}

const inScope = (entries, method, path) => {
  const normalized = normalizePath(path);
  return entries.some((entry) => (entry.method ? entry.method === method && entry.path === normalized : normalized === entry.prefix || normalized.startsWith(`${entry.prefix}/`)));
};

/** Rotas reais do escopo que o contrato não documenta: [{ method, path }]. `routes` = [{ method, path }] (caminhos Express com :param ou com {param}). */
function undocumentedRoutes(contractDoc, routes, entries) {
  const documented = new Set();
  for (const [path, item] of Object.entries(contractDoc.paths)) for (const method of Object.keys(item)) documented.add(`${method.toUpperCase()} ${normalizePath(path)}`);
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    const key = `${route.method} ${normalizePath(route.path)}`;
    if (!inScope(entries, route.method, route.path) || documented.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ method: route.method, path: route.path.replace(/^\/api\/v\d+/, '').replace(/:([A-Za-z0-9_]+)/g, '{$1}') });
  }
  return out;
}

module.exports = { parseScope, inScope, undocumentedRoutes, normalizePath };
