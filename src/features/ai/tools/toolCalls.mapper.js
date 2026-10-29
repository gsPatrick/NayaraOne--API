'use strict';

/** Linha de ai.tool_calls -> objeto da API/serviço (camelCase). Argumentos e resultado já vêm sanitizados do banco. */
function toToolCall(row) {
  const r = row.get ? row.get({ plain: true }) : row;
  return {
    id: r.id, groupId: r.groupId, companyId: r.companyId, runId: r.runId, seq: r.seq, toolName: r.toolName, toolVersion: r.toolVersion,
    permissionCode: r.permissionCode, riskLevel: r.riskLevel, argsSanitized: r.argsSanitized, argsHash: r.argsHash,
    idempotencyKey: r.idempotencyKey, status: r.status, blockedReason: r.blockedReason, resultSummary: r.resultSummary,
    resultHash: r.resultHash, latencyMs: r.latencyMs, proposalId: r.proposalId, startedAt: r.startedAt, finishedAt: r.finishedAt,
    contentPurgedAt: r.contentPurgedAt,
  };
}

/** Foto para a trilha de auditoria: sem argumentos nem resultado (só estado, hashes e ids). */
function auditSnapshot(call) {
  return {
    id: call.id, runId: call.runId, seq: call.seq, toolName: call.toolName, status: call.status, blockedReason: call.blockedReason,
    argsHash: call.argsHash, resultHash: call.resultHash, proposalId: call.proposalId, latencyMs: call.latencyMs,
  };
}

module.exports = { toToolCall, auditSnapshot };
