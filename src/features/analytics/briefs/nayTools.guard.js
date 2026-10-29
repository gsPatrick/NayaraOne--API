'use strict';

/**
 * M9-D695 (3.1 a 3.4) — fronteira da NAY Diretoria no BI: catálogo FECHADO de 7 ferramentas de leitura e recusa de qualquer ferramenta do
 * BI que aceite consulta livre. A NAY recebe só read models, alertas e referências de origem; nunca SQL, expressão, nome de tabela, filtro
 * em texto livre ou código executável.
 *
 *  - `assertNoFreeQuery(def)`: 422 ANALYTICS_AI_TOOL_FREE_QUERY_FORBIDDEN para ferramenta do BI (nome `analytics.*`) com parâmetro de consulta
 *    livre. Chamada pelo registro de ferramentas no cadastro. Parâmetro de texto só passa com enum, pattern ou format uuid; propriedade com
 *    nome de consulta (sql, query, expression, filter, table, where, script, code...) é recusada até com enum.
 *  - `assertNayToolAllowed(name)`: 403 ANALYTICS_AI_TOOL_NOT_ALLOWED para ferramenta fora do catálogo; o bloqueio é contado em
 *    ai.tool_calls_blocked (counter nayaraone_api_ai_tool_calls_blocked_total).
 */
const client = require('prom-client');
const AppError = require('../../../utils/AppError');
const { register } = require('../../../utils/metrics');
const { NAY_TOOL_NAMES, BI_TOOL_PREFIX } = require('./nayTools.names');

const FORBIDDEN_NAMES = /(?:^|[^a-z])(sql|query|queries|consulta|expression|expressao|expr|filter|filtro|where|having|table|tabela|schema|statement|script|code|codigo|command|comando|raw|eval|formula|join|select)(?:[^a-z]|$)/i;
const STRING_TYPES = new Set(['string']);

const blocked = register.getSingleMetric('nayaraone_api_ai_tool_calls_blocked_total')
  || new client.Counter({ name: 'nayaraone_api_ai_tool_calls_blocked_total', help: 'Chamadas de ferramenta da NAY bloqueadas (ai.tool_calls_blocked)', labelNames: ['reason'], registers: [register] });

const freeQuery = (tool, path, reason) => AppError.unprocessable('Ferramentas não podem aceitar consulta livre.', 'ANALYTICS_AI_TOOL_FREE_QUERY_FORBIDDEN', { tool: tool || null, path, reason });
const notAllowed = (tool) => AppError.forbidden('Ferramenta não permitida para este agente.', 'ANALYTICS_AI_TOOL_NOT_ALLOWED', { tool: String(tool || '') });

const typesOf = (s) => (Array.isArray(s.type) ? s.type : [s.type]);
const restricted = (s) => Array.isArray(s.enum) || s.const !== undefined || typeof s.pattern === 'string' || s.format === 'uuid' || s.format === 'date';

function walk(schema, path, tool, nameOfProperty) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref !== undefined || schema.patternProperties || schema.additionalProperties === true || schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    throw freeQuery(tool, path || '(raiz)', 'propriedades_abertas');
  }
  if (nameOfProperty && FORBIDDEN_NAMES.test(nameOfProperty)) throw freeQuery(tool, path, 'nome_de_consulta');
  if (typesOf(schema).some((t) => STRING_TYPES.has(t)) && !restricted(schema)) throw freeQuery(tool, path || '(raiz)', 'texto_livre');
  for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[k])) schema[k].forEach((s, i) => walk(s, `${path}.${k}[${i}]`, tool, nameOfProperty));
  if (schema.items) walk(schema.items, `${path}[]`, tool, null);
  for (const [name, child] of Object.entries(schema.properties || {})) walk(child, path ? `${path}.${name}` : name, tool, name);
}

/** Ferramenta do BI (prefixo analytics.) com consulta livre no esquema de entrada: 422. As demais ferramentas passam. */
function assertNoFreeQuery(def) {
  if (!def || typeof def.name !== 'string' || !def.name.startsWith(BI_TOOL_PREFIX)) return;
  walk(def.inputSchema, '', def.name, null);
}

const countBlocked = (reason) => blocked.inc({ reason: String(reason || 'UNKNOWN') });

function assertNayToolAllowed(name) {
  if (!NAY_TOOL_NAMES.includes(name)) {
    countBlocked('NOT_ALLOWED');
    throw notAllowed(name);
  }
}

module.exports = { assertNoFreeQuery, assertNayToolAllowed, countBlocked, freeQuery, notAllowed };
