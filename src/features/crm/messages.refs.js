'use strict';

const { CrmConversation, FileQuarantine } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * ISO-R2 (verificação independente de 12/11/2026, rodada 3; DI-M9R-6): a conversa e a mídia em quarentena que a mensagem cita precisam ser da
 * MESMA empresa da mensagem. Antes, o `conversationId` vinha do corpo e só a FK simples para crm.conversations(id) o conferia; a checagem de FK
 * não passa pelo RLS, então a empresa B gravava mensagem apontando para a conversa da empresa A do mesmo grupo (201) e, com id inexistente,
 * recebia 500 da FK. O `mediaQuarantineId` não tinha FK nenhuma. Fora do escopo (de outra empresa ou inexistente) é 404, antes de gravar:
 * - conversa: `CONVERSATION_NOT_FOUND`, no padrão dos outros vínculos da mensagem (PERSON_NOT_FOUND, OPPORTUNITY_NOT_FOUND);
 * - mídia: `INTEGRATION_MESSAGING_MEDIA_NOT_FOUND`, o código que as rotas de mensagem já usam para a mídia não encontrada.
 * A empresa vai explícita no filtro (além do RLS), para valer também no worker. No banco, a migration 20260101009971 cria as FKs compostas.
 */
async function assertConversationRefsInScope({ companyId, conversationId, mediaQuarantineId }, transaction) {
  if (conversationId && !(await CrmConversation.findOne({ where: { id: conversationId, companyId }, attributes: ['id'], transaction }))) {
    throw AppError.notFound('Conversa não encontrada.', 'CONVERSATION_NOT_FOUND');
  }
  if (mediaQuarantineId && !(await FileQuarantine.findOne({ where: { id: mediaQuarantineId, companyId }, attributes: ['id'], transaction }))) {
    throw AppError.notFound('Arquivo da mídia não encontrado.', 'INTEGRATION_MESSAGING_MEDIA_NOT_FOUND');
  }
}

module.exports = { assertConversationRefsInScope };
