'use strict';

const AppError = require('../../../utils/AppError');
const { withAiFallback, MODE_DEGRADED } = require('./deterministic.mode');
const { toolEntry } = require('./deterministic.catalog');
const { initToolRegistry } = require('../tools/bootRegistry');
const { buildToolServices } = require('../toolServices');
const { buildToolContext } = require('../orchestrator/toolContext');
const { validateToolArgs } = require('../tools/argsValidator');
const { listTemplates } = require('../../../modules/legal/contracts/application/template.service');

const LIMITES = Object.freeze({ stringMax: 2000, arrayMax: 100 });
const READ_KINDS = Object.freeze(['READ_SERVICE', 'RULE_ENGINE', 'FILTER', 'KEYWORD_SEARCH']);

const notDeclared = (name) => AppError.notFound('Esta função não tem caminho determinístico declarado.', 'AI_DETERMINISTIC_NOT_DECLARED', { tool: name });
const forbidden = () => AppError.forbidden('Você não tem permissão para esta função.', 'PERMISSION_DENIED');

/** Os campos que a pessoa preenche na tela normal no lugar da ação proposta pela IA (do schema de entrada da própria tool). */
const formFields = (tool) => Object.entries((tool.inputSchema && tool.inputSchema.properties) || {}).map(([name, def]) => ({
  name, description: def.description || null, required: ((tool.inputSchema && tool.inputSchema.required) || []).includes(name),
}));

/** Os modelos de contrato pré-definidos (ativos) do tipo pedido, no lugar de um texto redigido por modelo. */
async function contractTemplates(input, transaction) {
  const modelos = await listTemplates(transaction, { contractType: input.contractType });
  return modelos.filter((m) => m.status === undefined || m.status === 'ACTIVE' || m.active !== false).map((m) => ({ id: m.id, name: m.name, contractType: m.contractType }));
}

/** Executa a leitura da tool SEM modelo: os mesmos serviços de aplicação, com a permissão da pessoa, e a busca só por palavras-chave. */
async function readThroughServices(auth, tool, input, kind, transaction) {
  const { args } = validateToolArgs(tool, input || {}, LIMITES);
  const scope = {
    groupId: auth.groupId, companyId: auth.companyId, userId: auth.userId, permissions: auth.permissions || [], userPermissions: auth.permissions || [], actorType: 'USER',
    lexicalOnly: kind === 'KEYWORD_SEARCH', execution: { allowsConfidential: false, allowsRestricted: false },
  };
  const { services, readModels } = buildToolServices(transaction, scope);
  const ctx = buildToolContext({ auth, companyId: auth.companyId, groupId: auth.groupId, services, readModels });
  return tool.execute(ctx, args);
}

/**
 * runDeterministic — o equivalente determinístico de UMA tool (M9-D228 3.2): leitura, regra, busca por palavras-chave ou filtro pelos serviços do ERP; modelos de contrato
 * pré-definidos; ou o formulário da tela normal para a ação que a IA proporia. Exige a permissão da própria tool e NUNCA grava nada: toda ação de negócio segue o caminho normal
 * da tela, com aprovação humana. Devolve { mode, functionId, kind, equivalent, data | templates | form }.
 */
async function runDeterministic(auth, toolName, input, transaction) {
  const entry = toolEntry(toolName);
  const registry = await initToolRegistry();
  const tool = registry.has(toolName) ? registry.get(toolName) : null;
  if (!entry || !tool) throw notDeclared(toolName);
  if (!(auth.permissions || []).includes(tool.permissionCode)) throw forbidden();
  const base = { mode: MODE_DEGRADED, functionId: toolName, kind: entry.kind, equivalent: entry.equivalent };
  if (entry.kind === 'PREDEFINED_TEMPLATE') return { ...base, templates: await contractTemplates(input || {}, transaction) };
  if (entry.kind === 'HUMAN_FORM' || tool.category !== 'READ') return { ...base, form: { fields: formFields(tool), approvalRequired: tool.requiresHumanApproval === true } };
  if (!READ_KINDS.includes(entry.kind)) throw notDeclared(toolName);
  return { ...base, data: await readThroughServices(auth, tool, input, entry.kind, transaction) };
}

/**
 * runAiFunction — roda a função com IA (`ai`) quando a IA está de pé e o caminho determinístico quando ela está fora ou cai na chamada (withAiFallback/resolveAiMode, M9-D243).
 * Devolve { mode, reason, result }. Defeito de programação continua sendo erro.
 */
function runAiFunction(auth, toolName, { ai, input }, transaction) {
  return withAiFallback(auth, { ai, deterministic: () => runDeterministic(auth, toolName, input, transaction) }, transaction);
}

module.exports = { runDeterministic, runAiFunction, formFields };
