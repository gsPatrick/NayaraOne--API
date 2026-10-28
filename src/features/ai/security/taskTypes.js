'use strict';

const { taskTypeUnknown } = require('./privacy.errors');

/**
 * Registro dos tipos de tarefa (taskType) com a lista branca de campos que o prompt pode levar (M9-D027, minimização).
 * Cada tipo declara: `fields` (caminhos permitidos, ex. "parcela.valor"; lista dentro de lista é percorrida), `nameFields`
 * (caminhos que trazem nome de pessoa), `needsName` (a tarefa precisa do nome: não pseudonimiza) e `needsRestricted`.
 * Tipo não registrado é recusado (falha fechada): ninguém envia campo sem lista branca.
 */
const registry = new Map();

function registerTaskType(name, definition = {}) {
  if (typeof name !== 'string' || !name.trim()) throw new TypeError('taskType precisa de um nome');
  const fields = Array.isArray(definition.fields) ? definition.fields.filter((f) => typeof f === 'string') : [];
  registry.set(name, Object.freeze({
    name,
    fields: Object.freeze(fields),
    nameFields: Object.freeze(Array.isArray(definition.nameFields) ? [...definition.nameFields] : []),
    needsName: definition.needsName === true,
    needsRestricted: definition.needsRestricted === true,
  }));
  return registry.get(name);
}

function getTaskType(name) {
  const def = registry.get(name);
  if (!def) throw taskTypeUnknown(name);
  return def;
}

function unregisterTaskType(name) { return registry.delete(name); }

module.exports = { registerTaskType, getTaskType, unregisterTaskType };
