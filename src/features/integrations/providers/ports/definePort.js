'use strict';

const { IntegrationAdapter } = require('../../registry/IntegrationAdapter');
const { DOMAIN_CAPABILITIES } = require('../catalog.domains');

/** Saída normalizada de toda operação (INT-009): validada por schema antes de sair do adapter. */
const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['status'],
  properties: {
    externalRequestId: { type: ['string', 'null'], maxLength: 160 },
    externalResourceId: { type: ['string', 'null'], maxLength: 160 },
    status: { type: 'string', minLength: 1, maxLength: 64 },
  },
});

/**
 * definePort — cria a classe do port de um domínio. `operations`: nome da capability -> lista de campos obrigatórios do
 * pedido (ou { required, properties, outputMapper } para um JSON Schema mais rico e o mapper de saída da M9-D219). As operações PRECISAM ser capabilities do domínio
 * (aqui) e cobri-las todas (o teste de consistência confere). Cada port é versionado (`portVersion`).
 */
function definePort(className, domain, operations, portVersion = '1') {
  const nomes = Object.keys(operations);
  const esperado = DOMAIN_CAPABILITIES[domain];
  const fora = nomes.filter((n) => !esperado.includes(n));
  if (fora.length) throw new Error(`Port ${className}: operação fora das capabilities do domínio ${domain}: ${fora.join(', ')}`);
  const ops = {};
  nomes.forEach((nome) => {
    const def = Array.isArray(operations[nome]) ? { required: operations[nome] } : operations[nome];
    ops[nome] = Object.freeze({
      inputSchema: Object.freeze({ type: 'object', required: def.required || [], properties: def.properties || {} }),
      outputSchema: OUTPUT_SCHEMA,
      // M9-D219: mapper de saída da operação (allowlist + classificação). Operação sem dado de domínio no pedido não declara.
      outputMapper: def.outputMapper || null,
    });
  });
  const Port = class extends IntegrationAdapter {};
  Object.defineProperty(Port, 'name', { value: className });
  Object.defineProperty(Port, 'domain', { value: domain });
  Object.defineProperty(Port, 'portVersion', { value: portVersion });
  Object.defineProperty(Port, 'operations', { value: Object.freeze(ops) });
  return Port;
}

module.exports = { definePort, OUTPUT_SCHEMA };
