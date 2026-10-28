'use strict';

const E = require('./agents.errors');
const {
  CRITICALITIES, RISK_LEVELS, HIGH_RISK, CODE_RE, TOOL_NAME_RE, SCOPE_RE, LIMIT_SPECS,
} = require('./agents.constants');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateCode(code) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) {
    throw E.invalid('Código do agente inválido. Use letras maiúsculas, números e _, começando por letra (3 a 60 caracteres).');
  }
  return code;
}

/** Código vindo de rota ou de consulta: normaliza para maiúsculas; o que não casa nunca existe. */
function normalizeCode(code) {
  const texto = String(code || '').trim().toUpperCase();
  return CODE_RE.test(texto) ? texto : null;
}

function validatePurpose(value) {
  if (typeof value !== 'string' || !value.trim()) throw E.invalid('A finalidade (purpose) do agente é obrigatória.');
  if (value.length > 2000) throw E.invalid('A finalidade do agente deve ter até 2000 caracteres.');
  return value.trim();
}

function validateSystemPolicy(value) {
  if (typeof value !== 'string') throw E.invalid('A política do agente deve ser um texto.');
  if (value.length > 20000) throw E.invalid('A política do agente deve ter até 20000 caracteres.');
  return value;
}

function validateModelPolicy(value) {
  if (!isObject(value)) throw E.invalid('A política de modelo deve ser um objeto.');
  if (value.maxOutputTokens !== undefined && !(Number.isInteger(value.maxOutputTokens) && value.maxOutputTokens > 0)) {
    throw E.invalid('maxOutputTokens da política de modelo deve ser um inteiro positivo.');
  }
  if (value.cacheableTaskTypes !== undefined
    && !(Array.isArray(value.cacheableTaskTypes) && value.cacheableTaskTypes.every((t) => typeof t === 'string' && t.trim()))) {
    throw E.invalid('cacheableTaskTypes da política de modelo deve ser uma lista de textos.');
  }
  return value;
}

function validateDataScopes(value) {
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || !SCOPE_RE.test(s))) {
    throw E.invalid('Os escopos de dados devem ser uma lista de nomes como crm.opportunities.');
  }
  return [...new Set(value)];
}

function validateLimits(value) {
  if (!isObject(value)) throw E.invalid('Os limites devem ser um objeto.');
  for (const [key, number] of Object.entries(value)) {
    const spec = LIMIT_SPECS[key];
    if (!spec) throw E.invalid(`Limite desconhecido: ${key}. Use: ${Object.keys(LIMIT_SPECS).join(', ')}.`);
    if (!Number.isInteger(number) || number < spec.min || number > spec.max) {
      throw E.invalid(`O limite ${key} deve ser um inteiro entre ${spec.min} e ${spec.max}.`);
    }
  }
  return value;
}

function validateCriticality(value) {
  if (!CRITICALITIES.includes(value)) throw E.invalid(`Criticidade inválida. Use: ${CRITICALITIES.join(', ')}.`);
  return value;
}

const FIELD_VALIDATORS = {
  purpose: validatePurpose,
  systemPolicy: validateSystemPolicy,
  modelPolicy: validateModelPolicy,
  dataScopes: validateDataScopes,
  limits: validateLimits,
  criticality: validateCriticality,
};

/** Valida só os campos presentes no payload; campo desconhecido é recusado (nada é gravado por engano). */
function validateAgentFields(payload) {
  const out = {};
  for (const [key, validate] of Object.entries(FIELD_VALIDATORS)) {
    if (payload[key] !== undefined) out[key] = validate(payload[key]);
  }
  return out;
}

function validateTool(raw) {
  if (!isObject(raw)) throw E.toolInvalid('Cada ferramenta deve ser um objeto.');
  const toolName = raw.toolName;
  if (typeof toolName !== 'string' || !TOOL_NAME_RE.test(toolName)) {
    throw E.toolInvalid('Nome de ferramenta inválido. Use minúsculas, números, _ e ponto, começando por letra.');
  }
  if (typeof raw.permissionCode !== 'string' || !raw.permissionCode.trim()) throw E.toolInvalid('A ferramenta precisa de um permissionCode.');
  const riskLevel = raw.riskLevel === undefined ? 'LOW' : raw.riskLevel;
  if (!RISK_LEVELS.includes(riskLevel)) throw E.toolInvalid(`Nível de risco inválido. Use: ${RISK_LEVELS.join(', ')}.`);
  const requiresHumanApproval = raw.requiresHumanApproval === undefined ? false : raw.requiresHumanApproval;
  const enabled = raw.enabled === undefined ? true : raw.enabled;
  if (typeof requiresHumanApproval !== 'boolean' || typeof enabled !== 'boolean') {
    throw E.toolInvalid('requiresHumanApproval e enabled devem ser verdadeiro ou falso.');
  }
  if (HIGH_RISK.includes(riskLevel) && !requiresHumanApproval) throw E.toolInvalid('Ferramenta de risco alto exige aprovação humana.', { tool: toolName });
  return { toolName, permissionCode: raw.permissionCode.trim(), riskLevel, requiresHumanApproval, enabled };
}

function validateTools(list) {
  if (!Array.isArray(list)) throw E.toolInvalid('A allowlist deve ser uma lista de ferramentas.');
  const tools = list.map(validateTool);
  const nomes = tools.map((t) => t.toolName);
  if (new Set(nomes).size !== nomes.length) throw E.toolInvalid('A allowlist tem ferramenta repetida.');
  return tools;
}

function validateIdempotencyKey(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw E.invalid('A chave de idempotência deve ser um texto de até 200 caracteres.');
  return value.trim();
}

module.exports = { validateCode, normalizeCode, validateAgentFields, validateTools, validateIdempotencyKey, validatePurpose };
