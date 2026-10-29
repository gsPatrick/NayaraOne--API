'use strict';

const { IntegrationError } = require('../../../models');

/**
 * Fecha o ciclo do retry humano (M9-D250): o erro que foi a RETRYING quando alguém mandou repetir (envio, evento de webhook ou fluxo de
 * sincronização) volta a OPEN se a repetição não deu certo, ou vai a RESOLVED, sem autor, quando deu. Quem muda o estado do alvo chama aqui,
 * na mesma transação. A referência é o `source_ref_id` do erro (id do envio, do evento ou do fluxo). Sem erro em RETRYING não faz nada.
 */
async function settleRetryingErrors(ctx, sourceRefId, outcome, transaction, note) {
  if (!sourceRefId || !ctx || !ctx.companyId) return 0;
  const patch = outcome === 'RESOLVED'
    ? { status: 'RESOLVED', resolvedAt: new Date(), resolutionNote: String(note || 'Repetição concluída com sucesso.').slice(0, 500) }
    : { status: 'OPEN' };
  const [alterados] = await IntegrationError.update(patch, { where: { companyId: ctx.companyId, financingCaseId: sourceRefId, status: 'RETRYING' }, transaction });
  return alterados;
}

module.exports = { settleRetryingErrors };
