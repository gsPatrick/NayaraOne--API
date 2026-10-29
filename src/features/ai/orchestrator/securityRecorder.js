'use strict';

// M9-D017 — gravador de tool calls da NAY para o executor (D002/D018) e para o autorizador: a linha da chamada vai à porta
// `toolCallStore` (ai.tool_calls, M9-D006), a tentativa BLOCKED vira evento de segurança na auditoria (usuário, agente,
// ferramenta, correlation id e um trecho curto e redigido do pedido) e o evento `ai.*` entra no outbox NA MESMA transação.

const crypto = require('node:crypto');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { publishToolCallBlocked } = require('../events');
const { maskSecrets } = require('../guards/secretPatterns');
const { loadSecuritySettings } = require('./securitySettings');

const AUDIT_ACTION = 'ai.tool_call.blocked';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pedido redigido (segredo e dado pessoal viram máscara) e cortado no limite do administrador; nunca o pedido inteiro. */
const excerpt = (texto, max) => (texto ? maskSecrets(texto).slice(0, max) : null);

function createSecurityRecorder({ execCtx, agentCode, requestText, transaction, toolCallStore, args }) {
  let ultimaChamada = null;
  const tenant = { groupId: execCtx.groupId, companyId: execCtx.companyId };
  const userId = execCtx.actor && execCtx.actor.type === 'USER' ? execCtx.actor.userId : null;

  async function auditarBloqueio(linha) {
    const { excerptMax } = await loadSecuritySettings(tenant, transaction);
    await registrarAuditoria({
      groupId: tenant.groupId,
      companyId: tenant.companyId,
      actorUserId: userId,
      action: AUDIT_ACTION,
      entityType: 'AiToolCall',
      entityId: linha.callId,
      beforeJson: { registro: 'inexistente' },
      afterJson: {
        toolName: linha.toolName || null, agentCode: agentCode || null, status: linha.status, blockedReason: linha.blockedReason || null,
        reason: linha.reason || null, capability: linha.capability || null, actor: execCtx.actorLabel || null,
        correlationId: linha.correlationId || execCtx.correlationId || null, runId: execCtx.runId || null,
        requestExcerpt: excerpt(requestText, excerptMax),
      },
      reason: `Chamada de ferramenta da NAY bloqueada (${linha.blockedReason || linha.reason || 'segurança'}).`,
    }, transaction);
  }

  return {
    async record(entrada) {
      const callId = entrada.callId || crypto.randomUUID();
      ultimaChamada = callId;
      const linha = { ...entrada, callId, agentCode: agentCode || null, runId: execCtx.runId || null, actor: execCtx.actor, args };
      if (toolCallStore) await toolCallStore.record(linha, transaction);
      if (linha.status === 'BLOCKED') await auditarBloqueio(linha);
    },
    async emit({ payload }) {
      const callId = (payload && payload.callId) || ultimaChamada || crypto.randomUUID();
      await publishToolCallBlocked(tenant, {
        toolCallId: callId, runId: execCtx.runId || null, toolName: payload.toolName || 'desconhecida',
        reason: payload.blockedReason || payload.reason || payload.capability || 'bloqueada',
      }, transaction, {
        // a coluna do outbox é uuid: só o correlation id no formato do sistema vai; senão vale o da requisição em curso
        correlationId: UUID.test(String(execCtx.correlationId)) ? execCtx.correlationId : undefined,
      });
    },
  };
}

module.exports = { createSecurityRecorder, AUDIT_ACTION };
