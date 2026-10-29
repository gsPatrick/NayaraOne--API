'use strict';

const { listOperations, documented4xx } = require('./operations');
const { exampleMissing, exampleInvalid } = require('./contract.errors');
const { parseScope, undocumentedRoutes } = require('../openapi/scope');
const { undocumentedMessage, UNDOCUMENTED_CODE } = require('../openapi/openapi.errors');

/**
 * Cobertura do contract test (M9-D842 §3.2 e §3.3): toda operação do contrato precisa de ao menos um exemplo positivo (2xx) e um negativo (4xx documentado na própria operação);
 * operação sem nenhum 4xx documentado reprova na documentação; exemplo que aponta para operação inexistente reprova; rota real do escopo fechado ausente do contrato reprova
 * (mesma checagem da M9-D840). Rota fora do escopo não é exigida. Operação marcada `x-always-error: true` (o item do calendário é derivado e responde sempre 404, M9-D801 §4) não tem sucesso
 * a provar: basta o exemplo negativo.
 */
function coverageFindings({ doc, examples, routes, scopeJson }) {
  const findings = [];
  const operations = listOperations(doc);
  const byKey = new Map(operations.map((item) => [item.key, item]));
  for (const example of examples) {
    const target = byKey.get(example.op);
    if (!target) findings.push(exampleInvalid(`a operação ${example.op} do exemplo "${example.name}" não existe no contrato`, { op: example.op, file: example.file }));
    else if (example.kind === 'negative' && !documented4xx(target.operation).includes(String(example.expect))) findings.push(exampleInvalid(`o status ${example.expect} do exemplo negativo "${example.name}" não é um 4xx documentado em ${example.op}`, { op: example.op }));
  }
  for (const item of operations) {
    const mine = examples.filter((example) => example.op === item.key);
    const negatives = documented4xx(item.operation);
    if (!negatives.length) findings.push(exampleMissing(item.key, { op: item.key, reason: 'NO_4XX_DOCUMENTED' }));
    if (!item.operation['x-always-error'] && !mine.some((example) => example.kind === 'positive')) findings.push(exampleMissing(item.key, { op: item.key, missing: 'positive' }));
    if (negatives.length && !mine.some((example) => example.kind === 'negative')) findings.push(exampleMissing(item.key, { op: item.key, missing: 'negative' }));
  }
  if (routes && scopeJson) {
    for (const route of undocumentedRoutes(doc, routes, parseScope(scopeJson))) findings.push({ code: UNDOCUMENTED_CODE, message: undocumentedMessage(route.method, route.path), details: route });
  }
  return findings;
}

module.exports = { coverageFindings };
