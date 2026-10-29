'use strict';

const { validate } = require('./schema.validate');
const { documentedResponse } = require('./operations');
const { schemaMismatch, statusNotDocumented, errorCodeUnknown } = require('./contract.errors');

const JSON_TYPE = /^application\/(.+\+)?json\b/i;
const refName = (ref) => (ref && /^#\/components\/headers\/(.+)$/.exec(ref) || [])[1];

function headerSpec(spec, components) {
  const name = refName(spec && spec.$ref);
  return name && components && components.headers ? components.headers[name] || {} : spec || {};
}

/** Cabeçalhos documentados na resposta: obrigatório ausente reprova; presente é conferido contra o esquema (texto numérico vale como número). */
function headerProblems(response, actualHeaders, components) {
  const out = [];
  for (const [name, rawSpec] of Object.entries(response.headers || {})) {
    const spec = headerSpec(rawSpec, components);
    const value = actualHeaders[name.toLowerCase()];
    if (value === undefined || value === null) {
      if (spec.required) out.push(`cabeçalho ${name} documentado e ausente`);
      continue;
    }
    if (spec.schema) {
      const typed = spec.schema.type === 'integer' || spec.schema.type === 'number' ? Number(value) : value;
      for (const problem of validate(spec.schema, typed, components, name)) out.push(`cabeçalho ${problem.path}: ${problem.message}`);
    }
  }
  return out;
}

/** Formato único de erro (M9-D800 §3.4): {success:false,error:{code,message,details?,traceId}}; traceId dentro de error, nunca na raiz. */
function errorFormatProblems(json, actualHeaders) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ['corpo de erro não é um objeto JSON'];
  const out = [];
  if (json.success !== false) out.push('success deve ser false');
  if ('traceId' in json) out.push('traceId na raiz (deve ficar dentro de error)');
  const extra = Object.keys(json).filter((key) => !['success', 'error'].includes(key));
  if (extra.length) out.push(`campos fora do formato único na raiz: ${extra.join(', ')}`);
  const error = json.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return [...out, 'error ausente ou não é objeto'];
  for (const name of ['code', 'message', 'traceId']) if (typeof error[name] !== 'string' || !error[name]) out.push(`error.${name} ausente ou vazio`);
  const correlation = actualHeaders['x-correlation-id'];
  if (typeof error.traceId === 'string' && correlation && correlation !== error.traceId) out.push('error.traceId difere de X-Correlation-Id');
  return out;
}

/**
 * Confere UMA resposta real contra a operação do contrato (M9-D842 §3.1). `actual` = { status, headers (nomes em minúsculas), contentType, json, text }. `codes` = Set dos códigos do
 * catálogo (D843). Devolve os achados: status não documentado, corpo fora do esquema, cabeçalho ausente, formato de erro e código fora do catálogo.
 */
function checkResponse({ method, path, operation, components, codes, actual }) {
  const response = documentedResponse(operation, actual.status);
  if (!response) return [statusNotDocumented(actual.status, path, { method, documented: Object.keys(operation.responses || {}) })];
  const problems = [];
  const content = response.content || {};
  const types = Object.keys(content);
  const type = String(actual.contentType || '').split(';')[0].trim().toLowerCase();
  if (!types.length) {
    if (actual.text) problems.push(`o contrato não documenta corpo para o ${actual.status} e a API devolveu um`);
  } else if (!types.some((t) => t.toLowerCase() === type)) {
    problems.push(`tipo de conteúdo ${type || '(vazio)'} fora dos documentados (${types.join(', ')})`);
  } else if (JSON_TYPE.test(type)) {
    const schema = content[types.find((t) => t.toLowerCase() === type)].schema;
    if (actual.json === undefined) problems.push('corpo não é JSON válido');
    else if (schema) for (const problem of validate(schema, actual.json, components)) problems.push(`${problem.path}: ${problem.message}`);
  }
  problems.push(...headerProblems(response, actual.headers, components));
  const findings = [];
  const isError = actual.status >= 400;
  if (isError && JSON_TYPE.test(type)) problems.push(...errorFormatProblems(actual.json, actual.headers));
  const allowed = [response['x-error-code'], ...(response['x-error-codes'] || [])].filter(Boolean);
  if (isError && allowed.length && actual.json && actual.json.error && !allowed.includes(actual.json.error.code)) problems.push(`código ${actual.json.error.code} difere do documentado ${allowed.join(' ou ')}`);
  if (problems.length) findings.push(schemaMismatch(method, path, { status: actual.status, problems }));
  const code = isError && actual.json && actual.json.error && actual.json.error.code;
  if (typeof code === 'string' && codes && !codes.has(code)) findings.push(errorCodeUnknown(code));
  return findings;
}

module.exports = { checkResponse, errorFormatProblems, headerProblems };
