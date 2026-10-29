'use strict';

const crypto = require('node:crypto');
const { AiRun } = require('../../../models');
const E = require('./runApi.errors');

const HOUR_MS = 3600000;

/** Finalidade do run de uma conversa com agente (o chat não pede finalidade ao cliente). */
const chatPurpose = (agentCode) => `Conversa com o agente ${String(agentCode).trim().toUpperCase()}`.slice(0, 200);

/**
 * Histórico da sessão: as últimas `maxMessages` mensagens (do usuário e da NAY, da mais antiga à mais nova) dos runs CONCLUÍDOS da
 * conversa. É só entrada do próximo run (nada vira memória, AI-010): o texto é o resumo já redigido que o run guarda.
 */
function historyOf(rows, maxMessages) {
  if (maxMessages <= 0) return [];
  const messages = [];
  for (const row of rows) {
    if (row.status !== 'COMPLETED' || !row.outputSummary) continue;
    if (row.inputSummary) messages.push({ role: 'user', content: row.inputSummary });
    messages.push({ role: 'assistant', content: row.outputSummary });
  }
  return messages.slice(-maxMessages);
}

/**
 * Resolve o `conversationId` do chat. Sem id, nasce um novo. Com id sem nenhum run, ele é adotado (o cliente escolheu o agrupador).
 * Conversa de outra pessoa ou de outro agente: 404 sem revelar existência. Passada a validade (do primeiro run): 410.
 * Retorna { conversationId, history }.
 */
async function resolveConversation(ctx, { conversationId, agentCode }, { maxMessages, validityHours, nowMs }, transaction) {
  if (!conversationId) return { conversationId: crypto.randomUUID(), history: [] };
  const rows = await AiRun.findAll({
    where: { companyId: ctx.companyId, conversationId },
    order: [['startedAt', 'ASC'], ['id', 'ASC']],
    attributes: ['id', 'userId', 'agentName', 'status', 'startedAt', 'inputSummary', 'outputSummary'],
    transaction,
  });
  if (!rows.length) return { conversationId, history: [] };
  if (rows.some((r) => r.userId !== ctx.userId) || rows[0].agentName !== String(agentCode).trim().toUpperCase()) throw E.conversationNotFound();
  if (nowMs - new Date(rows[0].startedAt).getTime() > validityHours * HOUR_MS) throw E.conversationExpired();
  return { conversationId, history: historyOf(rows, maxMessages) };
}

module.exports = { resolveConversation, chatPurpose, historyOf };
