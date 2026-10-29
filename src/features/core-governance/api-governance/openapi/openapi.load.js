'use strict';

const yaml = require('js-yaml');
const { invalid } = require('./openapi.errors');

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** Lê o texto YAML/JSON do contrato e confere o mínimo para comparar: OpenAPI 3.0.x, info.version em SemVer e `paths`. Lança GOV_OPENAPI_INVALID (exit 2). */
function parseContract(text, label = 'contrato') {
  let doc;
  try {
    doc = yaml.load(String(text), { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw invalid(`${label} não é YAML válido (${String(err.message).split('\n')[0]})`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw invalid(`${label} está vazio ou não é um objeto`);
  if (typeof doc.openapi !== 'string' || !/^3\.0\.\d+$/.test(doc.openapi)) throw invalid(`${label}: "openapi" deve ser 3.0.x`);
  if (!doc.info || typeof doc.info.version !== 'string' || !SEMVER.test(doc.info.version)) throw invalid(`${label}: "info.version" deve ser SemVer MAJOR.MINOR.PATCH`);
  if (!doc.paths || typeof doc.paths !== 'object' || Array.isArray(doc.paths)) throw invalid(`${label}: "paths" é obrigatório`);
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith('/') || !item || typeof item !== 'object') throw invalid(`${label}: caminho inválido "${path}"`);
    for (const method of Object.keys(item).filter((key) => METHODS.includes(key))) {
      const operation = item[method];
      if (!operation || typeof operation !== 'object' || !operation.responses || typeof operation.responses !== 'object') throw invalid(`${label}: ${method.toUpperCase()} ${path} sem "responses"`);
    }
  }
  return doc;
}

const majorOf = (doc) => Number(doc.info.version.split('.')[0]);

module.exports = { parseContract, majorOf, METHODS };
