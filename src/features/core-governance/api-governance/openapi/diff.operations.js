'use strict';

const { METHODS } = require('./openapi.load');
const { resolve, jsonSchemaOf } = require('./diff.refs');
const { diffSchemas, change } = require('./diff.schema');
const { diffSecurity } = require('./diff.security');
const { diffErrorCodes } = require('./diff.errorCodes');

/** Chave de comparação de um caminho: parâmetros de caminho valem pela posição ({id} e {contractId} são o mesmo). */
const shape = (path) => path.replace(/\{[^}]+\}/g, '{}');
const operationsOf = (doc) => {
  const out = new Map();
  for (const [path, item] of Object.entries(doc.paths)) for (const method of METHODS.filter((m) => item[m])) out.set(`${method.toUpperCase()} ${shape(path)}`, { method: method.toUpperCase(), path, item, operation: item[method] });
  return out;
};

const paramKey = (param) => `${param.in}:${param.in === 'path' ? '' : param.name}`;
const paramsOf = (doc, item, operation) => {
  const map = new Map();
  const add = (raw) => { const param = resolve(doc, raw); if (param) { let key = paramKey(param); if (param.in === 'path') key += `${map.size}`; map.set(key, param); } };
  for (const raw of [...(item.parameters || []), ...(operation.parameters || [])]) add(raw);
  return map;
};

function diffParameters(baseDoc, candDoc, base, cand, where, out) {
  const baseParams = paramsOf(baseDoc, base.item, base.operation);
  const candParams = paramsOf(candDoc, cand.item, cand.operation);
  const pathCount = (map) => [...map.values()].filter((p) => p.in === 'path').length;
  for (const [key, param] of baseParams) {
    if (param.in === 'path') { if (pathCount(baseParams) > pathCount(candParams)) out.push(change('PARAM_REMOVED', 1, where, `parâmetro de caminho "${param.name}" removido`)); continue; }
    const next = candParams.get(key);
    if (!next) { out.push(change('PARAM_REMOVED', 1, where, `parâmetro ${param.in} "${param.name}" removido`)); continue; }
    if (!param.required && next.required) out.push(change('REQUEST_REQUIRED_ADDED', 3, where, `parâmetro "${param.name}" passou a ser obrigatório`));
    if (param.schema && next.schema) out.push(...diffSchemas(baseDoc, candDoc, param.schema, next.schema, 'request', `${where} ${param.in}:${param.name}`));
  }
  for (const [key, param] of candParams) if (param.in !== 'path' && param.required && !baseParams.has(key)) out.push(change('REQUEST_REQUIRED_ADDED', 3, where, `parâmetro obrigatório novo "${param.name}"`));
}

function diffBodyAndResponses(baseDoc, candDoc, base, cand, where, out) {
  const baseBody = resolve(baseDoc, base.operation.requestBody);
  const candBody = resolve(candDoc, cand.operation.requestBody);
  if (candBody && candBody.required === true && !(baseBody && baseBody.required === true)) out.push(change('REQUEST_REQUIRED_ADDED', 3, where, 'corpo da requisição passou a ser obrigatório'));
  const baseReq = baseBody && jsonSchemaOf(baseDoc, baseBody);
  const candReq = candBody && jsonSchemaOf(candDoc, candBody);
  if (baseReq && candReq) out.push(...diffSchemas(baseDoc, candDoc, baseReq, candReq, 'request', `${where} requestBody`));
  for (const [status, response] of Object.entries(base.operation.responses)) {
    const next = cand.operation.responses[status];
    if (!next) { out.push(change('RESPONSE_REMOVED', 1, where, `resposta ${status} removida`)); continue; }
    const baseRes = jsonSchemaOf(baseDoc, response);
    const candRes = jsonSchemaOf(candDoc, next);
    if (baseRes && candRes) out.push(...diffSchemas(baseDoc, candDoc, baseRes, candRes, 'response', `${where} ${status}`));
  }
}

/** Compara rotas, métodos, parâmetros, corpos, respostas, segurança e códigos de erro (regras 1 a 9). */
function diffOperations(baseDoc, candDoc, options = {}) {
  const baseOps = operationsOf(baseDoc);
  const candOps = operationsOf(candDoc);
  const candById = new Map([...candOps.values()].filter((o) => o.operation.operationId).map((o) => [o.operation.operationId, o]));
  const out = [];
  for (const [key, base] of baseOps) {
    const where = `${base.method} ${base.path}`;
    const cand = candOps.get(key);
    if (!cand) {
      const moved = base.operation.operationId && candById.get(base.operation.operationId);
      const pathStillThere = Object.keys(candDoc.paths).some((p) => shape(p) === shape(base.path));
      if (moved && !pathStillThere) out.push(change('ROUTE_RENAMED', 2, where, `rota renomeada para ${moved.method} ${moved.path}`));
      else out.push(change(pathStillThere ? 'METHOD_REMOVED' : 'ROUTE_REMOVED', 1, where, pathStillThere ? 'método removido' : 'rota removida'));
      continue;
    }
    diffParameters(baseDoc, candDoc, base, cand, where, out);
    diffBodyAndResponses(baseDoc, candDoc, base, cand, where, out);
    out.push(...diffSecurity(baseDoc, candDoc, base, cand, where));
    out.push(...diffErrorCodes(base, cand, where, options.errorCatalog));
  }
  return out;
}

module.exports = { diffOperations };
