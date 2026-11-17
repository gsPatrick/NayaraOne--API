'use strict';

/**
 * Vencimento padrão dos lançamentos de teste (segunda leva de 16/11/2026, DI-BI2-6: o lançamento PRÓPRIO a pagar ou a receber exige
 * `dueAt`, e a API recusa sem ele com 422 FINANCE_ENTRY_DUE_DATE_REQUIRED; a cobrança de perda exige `chargeDueAt` com 422
 * LOSS_CASE_CHARGE_DUE_REQUIRED).
 *
 * HOJE ao meio-dia de São Paulo (UTC-03:00, sem horário de verão desde 2019), como as datas puras do sistema (utils/businessDate.js):
 * a competência derivada do vencimento (resolveCompetenceMonth) é o mês de hoje, a mesma de quando o vencimento faltava, e o
 * lançamento não fica vencido hoje (vencido só a partir de amanhã, isDueDateOverdue). Uso: `{ ..., dueAt: vencimentoDeTeste() }`.
 * Precedente: test/testHelpers.js (centros de teste) e test/helpers/prazoEtapaPadrao.js. Não é teste.
 */

function hojeEmSaoPaulo(agora = new Date()) {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

function vencimentoDeTeste(agora = new Date()) {
  return new Date(`${hojeEmSaoPaulo(agora)}T12:00:00-03:00`).toISOString();
}

module.exports = { vencimentoDeTeste, hojeEmSaoPaulo };
