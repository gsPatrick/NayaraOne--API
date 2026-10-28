'use strict';

/**
 * Validador mínimo de JSON Schema (subconjunto) para o config_json de cada provider:
 * type, required, properties, additionalProperties:false, enum, pattern, minLength, maxLength,
 * minimum, maximum, items. Devolve a lista de problemas (vazia = válido).
 */
function tipoDe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validar(schema, valor, caminho = '$', problemas = []) {
  if (!schema || typeof schema !== 'object' || Object.keys(schema).length === 0) return problemas;
  const tipo = tipoDe(valor);
  if (schema.type) {
    const aceitos = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = aceitos.some((t) => t === tipo || (t === 'number' && tipo === 'integer'));
    if (!ok) {
      problemas.push(`${caminho}: esperado ${aceitos.join(' ou ')}`);
      return problemas;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(valor)) problemas.push(`${caminho}: valor fora da lista permitida`);
  if (typeof valor === 'string') {
    if (schema.minLength !== undefined && valor.length < schema.minLength) problemas.push(`${caminho}: texto curto demais`);
    if (schema.maxLength !== undefined && valor.length > schema.maxLength) problemas.push(`${caminho}: texto longo demais`);
    if (schema.pattern && !new RegExp(schema.pattern).test(valor)) problemas.push(`${caminho}: formato inválido`);
  }
  if (typeof valor === 'number') {
    if (schema.minimum !== undefined && valor < schema.minimum) problemas.push(`${caminho}: abaixo do mínimo`);
    if (schema.maximum !== undefined && valor > schema.maximum) problemas.push(`${caminho}: acima do máximo`);
  }
  if (tipo === 'array' && schema.items) valor.forEach((item, i) => validar(schema.items, item, `${caminho}[${i}]`, problemas));
  if (tipo === 'object') {
    for (const obrigatorio of schema.required || []) {
      if (valor[obrigatorio] === undefined) problemas.push(`${caminho}.${obrigatorio}: obrigatório`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(valor)) {
      if (props[k]) validar(props[k], v, `${caminho}.${k}`, problemas);
      else if (schema.additionalProperties === false) problemas.push(`${caminho}.${k}: campo não previsto`);
    }
  }
  return problemas;
}

module.exports = { validar };
