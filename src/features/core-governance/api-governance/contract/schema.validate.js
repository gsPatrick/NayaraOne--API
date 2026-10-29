'use strict';

/**
 * Validador de corpo contra o esquema OpenAPI 3.0 do contrato (M9-D842 §3.1: tipos, obrigatórios, enums, formatos). Sem dependência externa: cobre o subconjunto que o contrato usa
 * ($ref local, type, nullable, required, properties, additionalProperties, items, enum, format, limites, allOf/anyOf/oneOf). Devolve [{ path, message }]; vazio = válido.
 */
const FORMATS = {
  'date-time': (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(v) && !Number.isNaN(Date.parse(v)),
  date: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)),
  uuid: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  uri: (v) => /^[a-z][a-z0-9+.-]*:\S+$/i.test(v) || v.startsWith('/'),
};

const kindOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

function resolveRef(schema, components) {
  let current = schema;
  for (let depth = 0; current && current.$ref && depth < 20; depth += 1) {
    const match = /^#\/components\/schemas\/(.+)$/.exec(current.$ref);
    current = match && components && components.schemas ? components.schemas[match[1]] : undefined;
    if (!current) return { $unresolved: schema.$ref };
  }
  return current || {};
}

function typeProblem(schema, value) {
  const kind = kindOf(value);
  if (schema.type === 'integer') return kind === 'number' && Number.isInteger(value) ? null : `esperava integer e veio ${kind}`;
  if (schema.type === 'number') return kind === 'number' ? null : `esperava number e veio ${kind}`;
  return kind === schema.type ? null : `esperava ${schema.type} e veio ${kind}`;
}

function scalarProblems(schema, value, at) {
  const out = [];
  if (typeof value === 'string') {
    if (schema.format && FORMATS[schema.format] && !FORMATS[schema.format](value)) out.push({ path: at, message: `formato ${schema.format} inválido` });
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push({ path: at, message: `menor que minLength ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push({ path: at, message: `maior que maxLength ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push({ path: at, message: `não casa com o padrão ${schema.pattern}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push({ path: at, message: `menor que o mínimo ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) out.push({ path: at, message: `maior que o máximo ${schema.maximum}` });
  }
  if (schema.enum && !schema.enum.some((item) => item === value)) out.push({ path: at, message: `valor ${JSON.stringify(value)} fora do enum ${JSON.stringify(schema.enum)}` });
  return out;
}

function validate(rawSchema, value, components, at = '$') {
  const schema = resolveRef(rawSchema, components);
  if (schema.$unresolved) return [{ path: at, message: `referência ${schema.$unresolved} não resolvida` }];
  if (value === null && schema.nullable) return [];
  const out = [];
  for (const sub of schema.allOf || []) out.push(...validate(sub, value, components, at));
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((sub) => validate(sub, value, components, at).length === 0).length;
    if (hits !== 1) out.push({ path: at, message: `deve casar com exatamente um dos oneOf (casou com ${hits})` });
  }
  if (schema.anyOf && !schema.anyOf.some((sub) => validate(sub, value, components, at).length === 0)) out.push({ path: at, message: 'não casa com nenhum dos anyOf' });
  if (schema.type) {
    const problem = typeProblem(schema, value);
    if (problem) return [...out, { path: at, message: problem }];
  }
  out.push(...scalarProblems(schema, value, at));
  if (kindOf(value) === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push({ path: at, message: `menos que minItems ${schema.minItems}` });
    if (schema.items) value.forEach((item, index) => out.push(...validate(schema.items, item, components, `${at}[${index}]`)));
  }
  if (kindOf(value) === 'object') {
    for (const name of schema.required || []) if (!(name in value)) out.push({ path: `${at}.${name}`, message: 'campo obrigatório ausente' });
    const props = schema.properties || {};
    for (const [name, sub] of Object.entries(props)) if (name in value) out.push(...validate(sub, value[name], components, `${at}.${name}`));
    for (const name of Object.keys(value)) {
      if (name in props) continue;
      if (schema.additionalProperties === false) out.push({ path: `${at}.${name}`, message: 'campo não previsto no contrato' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') out.push(...validate(schema.additionalProperties, value[name], components, `${at}.${name}`));
    }
  }
  return out;
}

module.exports = { validate, resolveRef };
