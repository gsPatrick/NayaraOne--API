'use strict';

// M9-D016 — validação da definição de uma tool no registro. Qualquer falha é AI_TOOL_DEFINITION_INVALID (500) e derruba o
// boot: o servidor não sobe com tool incompleta, sem permissão válida ou que fira AI-007 (ação sensível sempre com aprovação humana).

const AppError = require('../../../utils/AppError');
const { RISK_LEVELS, HIGH_RISK, TOOL_NAME_RE } = require('../agents/agents.constants');
const { schemaWellFormed } = require('./outputSchema');
const { assertNoFreeQuery } = require('../../analytics/briefs/nayTools.guard');

const CATEGORIES = Object.freeze(['READ', 'WRITE']);
const DOMAINS = Object.freeze(['FINANCIAL', 'LEGAL', 'BANKING', 'PERMISSION', 'PUBLICATION', 'OTHER']);
const SENSITIVE_DOMAINS = Object.freeze(DOMAINS.filter((d) => d !== 'OTHER'));
const REQUIRED_FIELDS = Object.freeze(['name', 'version', 'description', 'permissionCode', 'riskLevel', 'category', 'domain',
  'inputSchema', 'outputSchema', 'requiresHumanApproval', 'idempotent', 'execute']);

const MENSAGEM_PADRAO = 'Definição de ferramenta inválida.';
const MENSAGEM_DOMINIO = 'Tool de escrita em domínio sensível exige aprovação humana';
const MENSAGEM_AI007 = 'AI-007: tool de risco HIGH ou CRITICAL exige aprovação humana.';

function invalid(tool, field, reason, message) {
  return new AppError(message || MENSAGEM_PADRAO, 500, 'AI_TOOL_DEFINITION_INVALID', { tool: tool || null, field, reason });
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkShape(def) {
  const tool = typeof def.name === 'string' ? def.name : null;
  for (const field of REQUIRED_FIELDS) {
    if (def[field] === undefined || def[field] === null) throw invalid(tool, field, 'campo_ausente');
  }
  if (typeof def.name !== 'string' || !TOOL_NAME_RE.test(def.name)) throw invalid(tool, 'name', 'nome_invalido');
  if (!Number.isInteger(def.version) || def.version < 1) throw invalid(tool, 'version', 'versao_invalida');
  if (typeof def.description !== 'string' || !def.description.trim()) throw invalid(tool, 'description', 'descricao_vazia');
  if (typeof def.permissionCode !== 'string' || !def.permissionCode.trim()) throw invalid(tool, 'permissionCode', 'permissao_vazia');
  if (!RISK_LEVELS.includes(def.riskLevel)) throw invalid(tool, 'riskLevel', 'risco_invalido');
  if (!CATEGORIES.includes(def.category)) throw invalid(tool, 'category', 'categoria_invalida');
  if (!DOMAINS.includes(def.domain)) throw invalid(tool, 'domain', 'dominio_invalido');
  if (typeof def.requiresHumanApproval !== 'boolean') throw invalid(tool, 'requiresHumanApproval', 'nao_booleano');
  if (typeof def.idempotent !== 'boolean') throw invalid(tool, 'idempotent', 'nao_booleano');
  if (typeof def.execute !== 'function') throw invalid(tool, 'execute', 'execute_nao_e_funcao');
  for (const field of ['inputSchema', 'outputSchema']) {
    if (!isObject(def[field]) || def[field].type !== 'object') throw invalid(tool, field, 'schema_raiz_precisa_ser_objeto');
    if (!schemaWellFormed(def[field])) throw invalid(tool, field, 'schema_malformado');
  }
}

function checkPolicy(def, permissionCodes) {
  if (!permissionCodes.has(def.permissionCode)) {
    throw invalid(def.name, 'permissionCode', 'permissao_inexistente', 'A permissão da ferramenta não existe no catálogo de permissões.');
  }
  if (HIGH_RISK.includes(def.riskLevel) && !def.requiresHumanApproval) {
    throw invalid(def.name, 'requiresHumanApproval', 'ai007_risco_alto', MENSAGEM_AI007);
  }
  if (def.category === 'WRITE' && SENSITIVE_DOMAINS.includes(def.domain) && !def.requiresHumanApproval) {
    throw invalid(def.name, 'requiresHumanApproval', 'ai007_dominio_sensivel', MENSAGEM_DOMINIO);
  }
}

function deepFreeze(valor) {
  if (valor && typeof valor === 'object' && !Object.isFrozen(valor)) {
    Object.freeze(valor);
    Object.values(valor).forEach(deepFreeze);
  }
  return valor;
}

/** Valida e devolve uma cópia congelada da definição (mudar o objeto original depois não altera o registro). */
function validateDefinition(def, permissionCodes) {
  if (!isObject(def)) throw invalid(null, 'definition', 'definicao_nao_e_objeto');
  checkShape(def);
  assertNoFreeQuery(def); // M9-D695: ferramenta do BI (analytics.*) com consulta livre: 422 ANALYTICS_AI_TOOL_FREE_QUERY_FORBIDDEN
  checkPolicy(def, permissionCodes);
  const copia = {};
  for (const field of REQUIRED_FIELDS) {
    copia[field] = typeof def[field] === 'object' ? JSON.parse(JSON.stringify(def[field])) : def[field];
  }
  copia.entityRefs = Array.isArray(def.entityRefs) ? def.entityRefs.map((r) => ({ arg: String(r.arg), entity: String(r.entity) })) : [];
  return deepFreeze(copia);
}

module.exports = { validateDefinition, invalid, CATEGORIES, DOMAINS, SENSITIVE_DOMAINS, REQUIRED_FIELDS };
