'use strict';

// M9-D017 — as verificações de CADA tool call, nesta ordem, parando na primeira falha:
//   (1) tool na allowlist do agente e habilitada; (2) permissão do registro nas permissões EFETIVAS (interseção);
//   (3) entidade referenciada por id, resolvida sob RLS, pertence à empresa do contexto; (4) argumentos válidos pelo schema
//   (D018), incluindo a recusa de companyId/groupId/userId; (5) pedido de segredo. Falha = linha BLOCKED + evento + erro.

const { toolNotAllowed } = require('../agents/agents.errors');
const { validateToolArgs, BLOCKED_REASON: SCHEMA_REASON } = require('../tools/argsValidator');
const { loadArgsLimits } = require('../tools/argsSettings');
const { findEntityCompany } = require('../readmodels/entityOwnership.readmodel');
const { detectSecretRequest } = require('../guards/secretRequest');
const { effectivePermissions, requiredPermission } = require('./executionContext');
const { permissionDenied, crossCompanyBlocked, secretRequestBlocked } = require('./toolSecurity.errors');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFUNDIDADE = 6;

function stringsOf(valor, fundo = 0) {
  if (typeof valor === 'string') return [valor];
  if (fundo >= PROFUNDIDADE || !valor || typeof valor !== 'object') return [];
  return Object.values(valor).flatMap((v) => stringsOf(v, fundo + 1));
}

async function authorizeToolCall({ execCtx, agent, registry, toolName, args, requestText, source, transaction, recorder, argsLimits, settings }) {
  const base = () => ({
    toolName, correlationId: execCtx.correlationId, companyId: execCtx.companyId, groupId: execCtx.groupId,
    inputKeys: args && typeof args === 'object' ? Object.keys(args) : [],
  });
  const bloquear = async (erro, blockedReason, extra = {}, eventos = []) => {
    const entrada = { ...base(), status: 'BLOCKED', blockedReason, reason: blockedReason.toLowerCase(), ...extra };
    await recorder.record(entrada);
    for (const type of ['ai.tool_call.blocked', ...eventos]) await recorder.emit({ type, payload: entrada });
    throw erro;
  };

  // (1) allowlist do agente
  const def = registry.get(toolName);
  const naLista = ((agent && agent.tools) || []).some((t) => t.enabled && t.toolName === toolName);
  if (!def || !naLista) await bloquear(toolNotAllowed(toolName), 'ALLOWLIST');

  // (2) permissão efetiva
  const efetivas = effectivePermissions(execCtx, agent, registry);
  if (!efetivas.includes(requiredPermission(def, execCtx))) await bloquear(permissionDenied(), 'PERMISSION');

  // (3) entidade de outra empresa (ou inexistente: mesma resposta)
  for (const ref of def.entityRefs || []) {
    const id = args && typeof args === 'object' ? args[ref.arg] : undefined;
    if (typeof id !== 'string' || !UUID.test(id)) continue; // valor mal formado é recusado pelo schema, no passo 4
    const dona = await findEntityCompany(ref.entity, id, transaction);
    if (dona !== execCtx.companyId) await bloquear(crossCompanyBlocked(), 'CROSS_COMPANY', { entity: ref.entity });
  }

  // (4) argumentos pelo schema da tool (D018)
  let validados;
  try {
    const limites = argsLimits || await loadArgsLimits({ companyId: execCtx.companyId, groupId: execCtx.groupId }, transaction);
    validados = validateToolArgs(def, args, limites).args;
  } catch (e) {
    if (!(e && e.details && e.details.blockedReason === SCHEMA_REASON)) throw e;
    await bloquear(e, SCHEMA_REASON, { reason: 'argumentos_invalidos', invalidFields: e.details.fields || [] });
  }

  // (5) pedido de segredo, no texto do pedido e nos textos dos argumentos
  for (const texto of [requestText, ...stringsOf(validados)]) {
    if (!texto) continue;
    const achado = detectSecretRequest(texto, { extraTerms: settings.extraTerms });
    if (achado.blocked) {
      await bloquear(secretRequestBlocked(), 'SECRET', {}, source === 'RETRIEVED' ? ['ai.security.prompt_injection_detected'] : []);
    }
  }
  return { def, effective: efetivas, args: validados };
}

module.exports = { authorizeToolCall };
