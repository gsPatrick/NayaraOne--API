'use strict';

// M9-D016 — validação e poda da SAÍDA de uma tool contra o outputSchema: campo fora do schema é descartado (não vaza coluna
// extra) e tipo errado ou campo obrigatório ausente é erro. Só os nomes dos campos entram no erro, nunca os valores.

const Ajv = require('ajv');
const AppError = require('../../../utils/AppError');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function criar(opcoes) {
  const ajv = new Ajv({ coerceTypes: false, allErrors: true, format: 'full', ...opcoes });
  ajv.addFormat('uuid', UUID);
  return ajv;
}

// removeAdditional:true poda o que o schema fecha com additionalProperties:false; closeObjects fecha todo objeto que declara `properties`.
const podador = criar({ removeAdditional: true });
const conferidor = criar({});
const compilados = new WeakMap(); // outputSchema -> função de validação

function schemaWellFormed(schema) {
  try {
    return conferidor.validateSchema(schema) === true;
  } catch (e) {
    return false;
  }
}

/** Cópia do schema em que todo objeto com `properties` e sem `additionalProperties` passa a rejeitar (e podar) o que não declara. */
function closeObjects(schema) {
  if (Array.isArray(schema)) return schema.map(closeObjects);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = (k === 'properties' && v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([n, f]) => [n, closeObjects(f)])) : closeObjects(v);
  if (out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

function validador(schema) {
  if (!compilados.has(schema)) compilados.set(schema, podador.compile(closeObjects(schema)));
  return compilados.get(schema);
}

/** Cópia da saída sem os campos fora do schema. Lança 500 AI_TOOL_OUTPUT_INVALID se a saída não cumpre o schema. */
function pruneOutput(tool, valor) {
  const copia = valor === undefined ? valor : JSON.parse(JSON.stringify(valor));
  const validar = validador(tool.outputSchema);
  if (!validar(copia)) {
    const campos = [...new Set((validar.errors || []).map((e) => (e.dataPath || '').replace(/^\./, '') || '(raiz)'))].slice(0, 20);
    throw new AppError('A ferramenta devolveu um resultado fora do formato declarado.', 500, 'AI_TOOL_OUTPUT_INVALID', { tool: tool.name, fields: campos });
  }
  return copia;
}

module.exports = { schemaWellFormed, pruneOutput };
