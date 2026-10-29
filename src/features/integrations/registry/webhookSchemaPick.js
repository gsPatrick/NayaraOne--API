'use strict';

/**
 * Escolha do esquema do evento de webhook declarado pelo adapter (M9-D212 e M9-D213): `webhookSchemas()` devolve { '<tipo>' ou '*': { '<versão>': esquema } }.
 * Fica em registry para a caixa de entrada e o worker usarem a mesma regra sem depender um do outro.
 */
function pickSchema(adapter, eventType, apiVersion) {
  const todos = adapter && typeof adapter.webhookSchemas === 'function' ? adapter.webhookSchemas() : null;
  if (!todos || typeof todos !== 'object') return null;
  const porVersao = (eventType && todos[eventType]) || todos['*'];
  return porVersao && apiVersion ? porVersao[apiVersion] || null : null;
}

/** Campos de primeiro nível que o esquema prevê: a lista permitida do payload sanitizado guardado com o erro (M9-D212 3.3). */
function allowlistOf(schema) {
  return schema && schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : undefined;
}

module.exports = { pickSchema, allowlistOf };
