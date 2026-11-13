'use strict';

const V = require('../../../../shared/validation/requestSchema');

/**
 * Tipo dos campos de `POST /finance/entries`, `/finance/approval-requests`, `/finance/commissions`, `/finance/reconciliations/group`,
 * `/finance/budget-forecasts`, `/finance/bank-transactions` e `/finance/bank-transactions/import` (data em ISO 8601 válida).
 * Rodada 8 da verificação do Marco 9 (12/11/2026; DI-M9R-25): o guarda genérico de tipo (clientTypeErrors.js) foi retirado, porque transformava em
 * 400 qualquer defeito do servidor sempre que o pedido trazia um número, um booleano ou uma lista. Estas rotas, que dependiam dele, passam a conferir
 * na porta o TIPO dos campos que o serviço usa em consulta ao banco (identificador em texto, texto, lista de identificadores). Esquemas ABERTOS
 * (campo que o esquema não cita passa, como sempre passou); a regra de negócio continua no serviço, com o código de erro do módulo.
 */

const ids = V.lista(V.identificador({ nulo: false, vazio: false }), { nulo: true });

const LANCAMENTO = V.objetoAberto({
  bankAccountId: V.identificador(), costCenterId: V.identificador(), resultCenterId: V.identificador(), contractId: V.identificador(),
  constructionProjectId: V.identificador(), chartOfAccountId: V.identificador(), thirdPartyOriginEntryId: V.identificador(),
  thirdPartyHolderPersonId: V.identificador(), thirdPartyCompensatedEntryId: V.identificador(),
  entryType: V.texto(), nature: V.texto(), description: V.texto(), competenceMonth: V.texto(), idempotencyKey: V.texto(),
  originRef: V.texto(), thirdPartyReference: V.texto(), thirdPartyReleaseType: V.texto(), dueAt: V.dataEmTexto(),
});
const APROVACAO = V.objetoAberto({ relatedEntityType: V.texto(), relatedEntityId: V.identificador(), riskLevel: V.texto() });
const COMISSAO = V.objetoAberto({
  opportunityId: V.identificador(), contractId: V.identificador(), beneficiaryUserId: V.identificador(), sourceEntryId: V.identificador(),
  component: V.texto(), idempotencyKey: V.texto(), firstDueAt: V.dataEmTexto(),
});
const CONCILIACAO_EM_GRUPO = V.objetoAberto({ financialEntryIds: ids, bankTransactionIds: ids });
const PREVISAO = V.objetoAberto({
  costCenterId: V.identificador(), resultCenterId: V.identificador(), competenceMonth: V.texto(), nature: V.texto(), description: V.texto(), forecastedAmount: V.numeroOuTexto(),
});
const TRANSACAO_BANCARIA = V.objetoAberto({ bankAccountId: V.identificador(), externalTransactionId: V.texto(), transactionDate: V.dataEmTexto(), description: V.texto() });
const IMPORTACAO_DE_EXTRATO = V.objetoAberto({ bankAccountId: V.identificador(), csvText: V.texto(), periodStart: V.dataEmTexto(), periodEnd: V.dataEmTexto() });

module.exports = {
  validarLancamento: V.validarEntrada({ body: LANCAMENTO }, 'FINANCE_ENTRY_VALIDATION'),
  validarPedidoDeAprovacao: V.validarEntrada({ body: APROVACAO }, 'FINANCE_APPROVAL_VALIDATION'),
  validarComissao: V.validarEntrada({ body: COMISSAO }, 'FINANCE_COMMISSION_VALIDATION'),
  validarConciliacaoEmGrupo: V.validarEntrada({ body: CONCILIACAO_EM_GRUPO }, 'FINANCE_RECONCILIATION_VALIDATION'),
  validarPrevisao: V.validarEntrada({ body: PREVISAO }, 'FINANCE_BUDGET_FORECAST_VALIDATION'),
  validarTransacaoBancaria: V.validarEntrada({ body: TRANSACAO_BANCARIA }, 'FINANCE_BANK_TRANSACTION_VALIDATION'),
  validarImportacaoDeExtrato: V.validarEntrada({ body: IMPORTACAO_DE_EXTRATO }, 'FINANCE_BANK_STATEMENT_IMPORT_VALIDATION'),
  ESQUEMAS: { LANCAMENTO, APROVACAO, COMISSAO, CONCILIACAO_EM_GRUPO, PREVISAO, TRANSACAO_BANCARIA, IMPORTACAO_DE_EXTRATO },
};
