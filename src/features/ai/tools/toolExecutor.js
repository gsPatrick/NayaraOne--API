'use strict';

// M9-D002 — executor interno de tools da NAY. Só roda função registrada, com o contexto fechado e congelado
// de toolContext.js. Toda recusa vira 403 AI_CAPABILITY_FORBIDDEN, uma linha BLOCKED no registro de tool calls
// (ai.tool_calls, M9-D006) e o evento `ai.tool_call.blocked` (M9-D029). Ação crítica nunca executa: vira proposta (M9-D019).

const AppError = require('../../../utils/AppError');
const { buildToolContext, guardContext, capacidadeNegada, CODIGO_CAPACIDADE_NEGADA } = require('../orchestrator/toolContext');
const { validateToolArgs, BLOCKED_REASON } = require('./argsValidator');
const { loadArgsLimits } = require('./argsSettings');
const { checkDerived } = require('./derivedArgs');

const DOMINIOS_COM_WORKFLOW = new Set(['FINANCIAL', 'LEGAL', 'BANKING', 'PERMISSION', 'PUBLICATION']);
const RISCOS_COM_WORKFLOW = new Set(['HIGH', 'CRITICAL']);

/** AI-007: financeira, jurídica, bancária, de permissão, publicação crítica, ou risco alto, nunca executa direto. */
function exigeWorkflow(tool) {
  return RISCOS_COM_WORKFLOW.has(tool.riskLevel) || DOMINIOS_COM_WORKFLOW.has(tool.domain) || tool.requiresHumanApproval === true;
}

function tabela(registry, nome) {
  if (!registry || typeof registry !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(registry, nome) ? registry[nome] : undefined;
}

/**
 * `argsLimits` ({ stringMax, arrayMax }) é opcional: sem ele, os limites da empresa (ia.tool.*) são lidos com a `transaction` do
 * tenant (M9-D018). Os argumentos são validados contra o inputSchema da tool ANTES de qualquer proposta ou execução.
 */
async function executeTool({ registry, toolName, input, contextParts, recorder, proposeAction, argsLimits, transaction, untrustedTexts, actorTexts, trustedValues, injectionLimits } = {}) {
  if (!recorder || typeof recorder.record !== 'function') {
    throw AppError.internal('Executor de tools sem registro de auditoria.', 'AI_AUDIT_RECORDER_REQUIRED');
  }
  const base = () => ({
    toolName, correlationId: contextParts && contextParts.correlationId,
    companyId: contextParts && contextParts.companyId, groupId: contextParts && contextParts.groupId,
    inputKeys: input && typeof input === 'object' ? Object.keys(input) : [],
  });
  const bloquear = async (erro, capability, reason) => {
    const entrada = { ...base(), status: 'BLOCKED', capability, reason: reason || (erro.details && erro.details.reason) || 'capacidade_nao_concedida' };
    await recorder.record(entrada);
    if (typeof recorder.emit === 'function') await recorder.emit({ type: 'ai.tool_call.blocked', payload: entrada });
    throw erro;
  };

  const tool = tabela(registry, toolName);
  if (!tool) return bloquear(capacidadeNegada('tool_nao_registrada', { tool: toolName, reason: 'tool_nao_registrada' }), 'tool_nao_registrada');
  if (typeof tool.execute !== 'function') return bloquear(capacidadeNegada('tool_sem_execute', { tool: toolName, reason: 'tool_sem_execute' }), 'tool_sem_execute');

  let ctx;
  try {
    ctx = buildToolContext(contextParts);
  } catch (e) {
    if (e && e.code === CODIGO_CAPACIDADE_NEGADA) return bloquear(e, (e.details && e.details.capability) || 'contexto');
    throw e;
  }

  let args;
  try {
    const limites = argsLimits || await loadArgsLimits({ companyId: ctx.companyId, groupId: ctx.groupId }, transaction);
    args = validateToolArgs(tool, input, limites).args;
  } catch (e) {
    if (!(e && e.details && e.details.blockedReason === BLOCKED_REASON) && !(e && e.code === 'AI_TOOL_DEFINITION_INVALID')) throw e;
    const entrada = { ...base(), status: 'BLOCKED', blockedReason: BLOCKED_REASON, reason: e.code === 'AI_TOOL_DEFINITION_INVALID' ? 'definicao_invalida' : 'argumentos_invalidos', invalidFields: (e.details && e.details.fields) || [] };
    await recorder.record(entrada);
    if (typeof recorder.emit === 'function') await recorder.emit({ type: 'ai.tool_call.blocked', payload: entrada });
    throw e;
  }

  // M9-D021: valor que só existe em conteúdo untrusted e vai para tool de escrita ou envio externo nunca executa direto.
  const derivedFields = await checkDerived({ args, untrustedTexts, actorTexts, trustedValues, injectionLimits, tenant: ctx, transaction });
  const derivedFromUntrusted = derivedFields.length > 0;
  const marca = derivedFromUntrusted ? { derivedFromUntrusted: true } : {};
  const alteraOuEnvia = tool.category === 'WRITE' || tool.externalSend === true;

  if (exigeWorkflow(tool) || (derivedFromUntrusted && alteraOuEnvia)) {
    if (typeof proposeAction !== 'function') {
      return bloquear(capacidadeNegada('acao_critica_sem_workflow', { tool: toolName, reason: 'acao_critica_sem_workflow' }), 'acao_critica_sem_workflow');
    }
    const proposta = await proposeAction({ tool: tool.name || toolName, toolVersion: tool.version, args, auth: ctx.auth, companyId: ctx.companyId, groupId: ctx.groupId, correlationId: ctx.correlationId, ...marca, ...(derivedFromUntrusted ? { derivedFields } : {}) });
    await recorder.record({ ...base(), status: 'PROPOSED', proposalId: proposta && proposta.id, ...marca });
    return { status: 'PROPOSED', proposal: proposta };
  }

  const tentativas = [];
  const visao = guardContext(ctx, (t) => tentativas.push(t));
  let saida;
  try {
    saida = await tool.execute(visao, args);
  } catch (e) {
    if (tentativas.length || (e && e.code === CODIGO_CAPACIDADE_NEGADA)) {
      const cap = (tentativas[0] && tentativas[0].capability) || (e.details && e.details.capability) || 'desconhecida';
      return bloquear(e && e.code === CODIGO_CAPACIDADE_NEGADA ? e : capacidadeNegada(cap, { path: tentativas[0] && tentativas[0].path }), cap);
    }
    await recorder.record({ ...base(), status: 'FAILED', reason: e && e.code ? String(e.code) : 'erro_da_tool' });
    throw e;
  }
  if (tentativas.length) {
    // a tool engoliu o erro: o pedido de capacidade proibida continua valendo como bloqueio
    return bloquear(capacidadeNegada(tentativas[0].capability, { path: tentativas[0].path }), tentativas[0].capability);
  }
  await recorder.record({ ...base(), status: 'SUCCEEDED', ...marca });
  return { status: 'SUCCEEDED', output: saida };
}

module.exports = { executeTool, exigeWorkflow };
