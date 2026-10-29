'use strict';

const { isIntegrationClass } = require('./classification');
const { PURPOSE_RE } = require('./purposeLimits');
const { runMapper } = require('./runMapper');

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const PATH_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

function validateFields(fields, where, problems) {
  const names = new Set();
  fields.forEach((f) => {
    if (!f || !NAME_RE.test(f.name || '')) { problems.push(`${where}: nome de campo inválido`); return; }
    if (names.has(f.name)) problems.push(`${where}: campo repetido ${f.name}`);
    names.add(f.name);
    if (f.from !== undefined && !PATH_RE.test(f.from)) problems.push(`${where}${f.name}: caminho de origem inválido`);
    if (f.classificationFrom !== undefined && !PATH_RE.test(f.classificationFrom)) problems.push(`${where}${f.name}: caminho de classificação inválido`);
    if (!isIntegrationClass(f.classification)) problems.push(`${where}${f.name}: classificação inválida`);
    if (f.items) validateFields(f.items, `${where}${f.name}[].`, problems);
    if (f.shape) validateFields(f.shape, `${where}${f.name}.`, problems);
  });
}

/**
 * defineMapper({ purpose, fields }) — declara o outputMapper de UMA operação de port (M9-D219 3.1). O payload é montado por
 * ALLOWLIST: só sai o que está em `fields`. Cada campo: `name` (chave no payload), `from` (caminho no objeto de domínio, padrão
 * = name), `classification` (escala de integração), `classificationFrom` (caminho de uma classificação de DOCUMENTO/IA do dado,
 * convertida pela tabela de equivalência), `required`, `freeText` (passa por redactFreeText), `pseudonymized`, `requiresConsent`,
 * `personalData` e `items` (lista de objetos com a mesma regra) e `shape` (objeto aninhado com a mesma regra). Devolve `outputMapper(domainObject, ctx) -> payload`, com
 * `.spec` e `.run(domainObject, ctx)` (relatório completo: payload, purpose, fieldsKept, fieldsDropped).
 */
function defineMapper(spec) {
  const problems = [];
  if (!spec || !PURPOSE_RE.test(spec.purpose || '')) problems.push('finalidade (purpose) inválida');
  if (!spec || !Array.isArray(spec.fields) || spec.fields.length === 0) problems.push('lista de campos vazia');
  else validateFields(spec.fields, '', problems);
  if (problems.length) throw new Error(`outputMapper inválido: ${problems.join('; ')}`);
  const frozen = Object.freeze({ purpose: spec.purpose, fields: Object.freeze(spec.fields.map((f) => Object.freeze({ ...f }))) });
  const outputMapper = (domainObject, ctx) => runMapper(frozen, domainObject, ctx).payload;
  outputMapper.spec = frozen;
  outputMapper.run = (domainObject, ctx) => runMapper(frozen, domainObject, ctx);
  return Object.freeze(outputMapper);
}

module.exports = { defineMapper };
