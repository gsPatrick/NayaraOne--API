'use strict';

const { METHODS } = require('../openapi/openapi.load');

/** Operações do contrato: [{ key: 'GET /x/{id}', method, path, operation }]. */
function listOperations(doc) {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item).filter((name) => METHODS.includes(name))) out.push({ key: `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path, operation: item[method] });
  }
  return out;
}

const statusClass = (status) => `${String(status)[0]}XX`;

/** A resposta documentada para o status (exata, depois "2XX" e "default"), ou null. */
function documentedResponse(operation, status) {
  const responses = operation.responses || {};
  return responses[String(status)] || responses[statusClass(status)] || responses.default || null;
}

/** Status 4xx documentados na própria operação (chaves numéricas 400 a 499 ou "4XX"). */
const documented4xx = (operation) => Object.keys(operation.responses || {}).filter((key) => /^4\d\d$/.test(key) || key === '4XX');

/** Preenche {param} do caminho do contrato com os valores (codificados). */
const fillPath = (path, params = {}) => path.replace(/\{([^}]+)\}/g, (_m, name) => encodeURIComponent(String(params[name] === undefined ? `{${name}}` : params[name])));

module.exports = { listOperations, documentedResponse, documented4xx, fillPath, statusClass };
