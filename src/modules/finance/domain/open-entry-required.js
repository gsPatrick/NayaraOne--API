'use strict';

/**
 * Campos obrigatórios do lançamento PRÓPRIO em aberto (segunda leva de 16/11/2026, item 16 e partes "A" dos itens 14 e 15a; DI-BI2-6).
 *
 * - Vencimento: o Caderno M4 §19 (relatório semanal de saúde) mede "Contas 7/30/60 dias", "Recebíveis 7/30/60 dias" e "Inadimplência:
 *   vencidos/total elegível". Sem a data de vencimento o lançamento a pagar ou a receber some dessas janelas e da inadimplência, e a
 *   verificação de completude do vencimento (finance_health_due_date_completeness, DI-VENC-1611-1) reprova. Vale para PAYABLE e RECEIVABLE
 *   PRÓPRIOS; o dinheiro de terceiro (caução, repasse ao proprietário) fica de fora, como no relatório de saúde, que o exclui do caixa.
 * - Centros: Caderno M4 §4 "Centro de custo obrigatório para despesa. Centro de resultado obrigatório para receita e análise de margem."
 *   A criação já exigia; a edição não pode apagar o centro, e o excedente classificado como receita precisa do centro de resultado.
 *
 * Regra pura (sem banco, sem HTTP): devolve o que falta; quem lança o erro de negócio é o serviço (application/services/open-entry-guards.js).
 */

const OWN_OPEN_NATURES = Object.freeze(['PAYABLE', 'RECEIVABLE']);

/** Ausente, nulo ou texto em branco. */
function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** O lançamento é a pagar ou a receber PRÓPRIO (não é dinheiro de terceiro). */
function requiresDueDate({ nature, isThirdPartyFunds }) {
  return OWN_OPEN_NATURES.includes(String(nature || '').toUpperCase()) && isThirdPartyFunds !== true;
}

/** Na criação: lançamento próprio a pagar ou a receber sem vencimento. */
function isMissingDueDate({ nature, isThirdPartyFunds, dueAt }) {
  return requiresDueDate({ nature, isThirdPartyFunds }) && isBlank(dueAt);
}

/**
 * Na edição: o campo obrigatório que o pedido tenta apagar (só conta o campo ENVIADO em branco; o omitido não muda nada).
 * Devolve 'dueAt', 'costCenterId', 'resultCenterId' ou null.
 */
function clearedRequiredField(entry, payload) {
  const body = payload || {};
  const sent = (field) => Object.prototype.hasOwnProperty.call(body, field) && body[field] !== undefined;
  if (sent('dueAt') && isBlank(body.dueAt) && requiresDueDate(entry)) return 'dueAt';
  if (entry.nature === 'PAYABLE' && sent('costCenterId') && isBlank(body.costCenterId)) return 'costCenterId';
  if (entry.nature === 'RECEIVABLE' && sent('resultCenterId') && isBlank(body.resultCenterId)) return 'resultCenterId';
  return null;
}

/**
 * Vencimento na edição. O vencimento é fato do lançamento (trigger append-only, migrations 366/382): pode ser PREENCHIDO uma vez num
 * lançamento ainda PENDING que não tinha data, nunca trocado por outra data nem apagado.
 * Devolve 'none' (não enviado, igual ao atual ou em branco quando já não havia data), 'fill' (sem data -> com data), 'change' (data
 * diferente da gravada) ou 'clear' (apagar a data gravada).
 */
function dueDateEdit(currentDueAt, nextDueAt) {
  if (nextDueAt === undefined) return 'none';
  if (isBlank(nextDueAt)) return currentDueAt ? 'clear' : 'none';
  if (!currentDueAt) return 'fill';
  return new Date(currentDueAt).getTime() === new Date(nextDueAt).getTime() ? 'none' : 'change';
}

/**
 * Classificação do excedente de um recebimento (Caderno §10): receita exige o centro de resultado; despesa vira conta a pagar própria
 * em aberto e exige centro de custo e vencimento. Devolve a lista do que falta (vazia quando completo).
 */
function missingForExcessClassification(finalNature, fields) {
  const { costCenterId, resultCenterId, dueAt } = fields || {};
  const missing = [];
  if (finalNature === 'RECEIVABLE' && isBlank(resultCenterId)) missing.push('resultCenterId');
  if (finalNature === 'PAYABLE' && isBlank(costCenterId)) missing.push('costCenterId');
  if (finalNature === 'PAYABLE' && isBlank(dueAt)) missing.push('dueAt');
  return missing;
}

module.exports = { OWN_OPEN_NATURES, isBlank, requiresDueDate, isMissingDueDate, clearedRequiredField, dueDateEdit, missingForExcessClassification };
