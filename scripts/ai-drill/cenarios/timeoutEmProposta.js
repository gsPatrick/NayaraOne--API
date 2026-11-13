'use strict';

/**
 * Drill (g) do livro: timeout de tool no meio de uma escrita proposta. A execução aprovada que estoura o tempo depois de escrever é desfeita (savepoint:
 * nenhuma meia execução), fica registrada como EXECUTION_FAILED e repetir a decisão nunca executa duas vezes; uma execução que conclui e é repetida
 * (o cliente não recebeu a resposta) devolve replayed e fica com um só pagamento.
 */
const approval = require('../../../src/features/ai/approval');
const paymentIntents = require('../../../src/modules/finance/application/services/payment.service');
const { ctxAprovador, contar, lerRec } = require('../../../test/marco9/_helpers/iaAprovacao');
const { propor, proporOutra } = require('../../../test/marco9/_helpers/iaAprovacaoFluxo');

const erroDeTempo = () => Object.assign(new Error('tempo esgotado ao chamar o serviço'), { code: 'ETIMEDOUT' });

/** Executa `fn` com a criação do pagamento estourando o tempo DEPOIS de gravar (o pior caso). */
async function comTimeoutNoMeio(fn) {
  const original = paymentIntents.createPaymentIntent;
  paymentIntents.createPaymentIntent = async (...args) => { await original(...args); throw erroDeTempo(); };
  try { return await fn(); } finally { paymentIntents.createPaymentIntent = original; }
}

module.exports = {
  id: 'timeout-em-proposta',
  letra: 'g',
  titulo: 'Timeout de tool no meio de uma escrita proposta',
  esperado: 'Estouro de tempo depois de gravar não deixa meia execução (zero pagamentos) e a repetição não executa de novo; a decisão concluída e repetida devolve replayed com um só pagamento.',
  async executar({ F, tenantA, relatorio }) {
    await F.withRollbackTenantTransaction(tenantA, async (tx) => {
      const { c, id } = await propor(tenantA, tx);
      const ctx = ctxAprovador(tenantA, c.aprovador);
      const falhou = await comTimeoutNoMeio(() => approval.approveRecommendation(ctx, id, {}, tx));
      relatorio.confere('o estouro de tempo vira EXECUTION_FAILED registrado', falhou.recommendation.status === 'EXECUTION_FAILED' && falhou.replayed === false, falhou.recommendation.status);
      relatorio.confere('nenhuma meia execução: zero pagamentos gravados', (await contar('finance.payment_intents', 'financial_entry_id = :e', { e: c.entry.id }, tx)) === 0);
      const repetida = await approval.approveRecommendation(ctx, id, {}, tx);
      relatorio.confere('repetir a decisão não executa de novo (replayed)', repetida.replayed === true);
      relatorio.confere('continua sem pagamento depois da repetição', (await contar('finance.payment_intents', 'financial_entry_id = :e', { e: c.entry.id }, tx)) === 0);
      relatorio.confere('a recomendação guarda o motivo, sem pilha', /ETIMEDOUT|tempo/i.test(String((await lerRec(id, tx)).outcomeDetail || (await lerRec(id, tx)).outcome_detail || '')));
      // Execução que conclui e é repetida porque o cliente não recebeu a resposta: um só pagamento.
      const outra = await proporOutra(tenantA, tx, c);
      const primeira = await approval.approveRecommendation(ctx, outra.id, {}, tx);
      const segunda = await approval.approveRecommendation(ctx, outra.id, {}, tx);
      relatorio.confere('a decisão concluída executa uma vez', primeira.replayed === false && primeira.recommendation.status === 'EXECUTED', primeira.recommendation.status);
      relatorio.confere('a repetição devolve replayed', segunda.replayed === true);
      relatorio.confere('um só pagamento para a segunda proposta', (await contar('finance.payment_intents', 'financial_entry_id = :e', { e: outra.entry.id }, tx)) === 1);
    });
  },
};
