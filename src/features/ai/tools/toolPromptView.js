'use strict';

// M9-D016 — o que o prompt da NAY enxerga de uma tool: nome, descrição e uma versão enxuta do inputSchema (tipos, enums,
// obrigatórios e descrições curtas). Permissão, risco, aprovação e execute nunca aparecem aqui.

const DESCRICAO_MAX = 160;

function slim(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  if (schema.type !== undefined) out.type = schema.type;
  if (Array.isArray(schema.enum)) out.enum = [...schema.enum];
  if (typeof schema.description === 'string') out.description = schema.description.slice(0, DESCRICAO_MAX);
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, slim(v)]));
  if (Array.isArray(schema.required)) out.required = [...schema.required];
  if (schema.items) out.items = slim(schema.items);
  return out;
}

const promptView = (def) => ({ name: def.name, description: def.description, inputSchema: slim(def.inputSchema) });

module.exports = { promptView, slim };
