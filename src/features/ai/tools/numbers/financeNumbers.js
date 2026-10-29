'use strict';

// M9-D026 — numbersPayload das tools financeiras: os valores saem do read model do Financeiro (financialHealthReport, Marco 4),
// já sob o RLS da empresa do ator e com `asOf`. Nada é calculado aqui além de somas decimais exatas (sumExact).

const AppError = require('../../../../utils/AppError');
const { financeHealth } = require('../../toolServices/finance.services');
const { sumExact, fractionToPercent } = require('../../orchestrator/numbers/decimalText');
const { hasNumberExtractor, extractNumbers } = require('./extractors');

const SOURCE = 'finance.getWeeklyHealthReport';
const PERMISSAO = 'finance:read';

const cents = (n) => Number(n || 0).toFixed(2);

function item(ref, label, value, unit, asOf) {
  return { ref, label, value: String(value), unit, source: SOURCE, asOf };
}

/** Itens do relatório de saúde financeira: inadimplência (valor e parcelas), a pagar, a receber, saldo projetado e janelas. */
function itemsFromReport(report) {
  const asOf = report.generatedAt;
  return [
    item('inadimplencia_valor', 'Inadimplência (a receber vencido)', cents(report.overdue.receivable.total), 'BRL', asOf),
    item('inadimplencia_parcelas', 'Parcelas inadimplentes', report.overdue.receivable.count, 'un', asOf),
    item('vencido_pagar_valor', 'A pagar vencido', cents(report.overdue.payable.total), 'BRL', asOf),
    item('vencido_total', 'Total vencido', cents(report.overdue.total), 'BRL', asOf),
    item('a_receber_valor', 'A receber (pendente)', cents(report.receivablePending.total), 'BRL', asOf),
    item('a_pagar_valor', 'A pagar (pendente)', cents(report.payablePending.total), 'BRL', asOf),
    item('saldo_projetado', 'Saldo líquido projetado', cents(report.projectedNetBalance), 'BRL', asOf),
    item('receber_7d', 'A receber em 7 dias', cents(report.dueNextSevenDays.receivable.total), 'BRL', asOf),
    item('pagar_7d', 'A pagar em 7 dias', cents(report.dueNextSevenDays.payable.total), 'BRL', asOf),
    item('receber_30d', 'A receber em 30 dias', cents(report.dueNext30Days.receivable.total), 'BRL', asOf),
    item('pagar_30d', 'A pagar em 30 dias', cents(report.dueNext30Days.payable.total), 'BRL', asOf),
    ...ratioItems(report),
  ];
}

function ratioItems(report) {
  if (report.delinquencyRatio === undefined || report.delinquencyRatio === null) return [];
  return [item('inadimplencia_percentual', 'Inadimplência sobre o total elegível', fractionToPercent(report.delinquencyRatio), '%', report.generatedAt)];
}

/** Saída da tool finance.getDelinquency (D016) -> itens do payload. */
function itemsFromDelinquency(out) {
  const asOf = out.generatedAt;
  return [
    item('inadimplencia_valor', 'Inadimplência (a receber vencido)', cents(out.overdueReceivable.total), 'BRL', asOf),
    item('inadimplencia_parcelas', 'Parcelas inadimplentes', out.overdueReceivable.count, 'un', asOf),
    item('vencido_pagar_valor', 'A pagar vencido', cents(out.overduePayable && out.overduePayable.total), 'BRL', asOf),
    item('vencido_total', 'Total vencido', cents(out.overdueTotal), 'BRL', asOf),
    ...ratioItems(out),
  ];
}

/** numbersPayload da saída (já validada pelo outputSchema) de uma tool financeira do ToolRegistry; outra tool não gera números. */
function numbersFromToolOutput(toolName, output) {
  if (hasNumberExtractor(toolName)) return extractNumbers(toolName, output);
  if (toolName === 'finance.getWeeklyHealth') return itemsFromReport(output);
  if (toolName === 'finance.getDelinquency') return itemsFromDelinquency(output);
  return [];
}

/** Item derivado por soma decimal EXATA de itens do payload (o modelo nunca soma). */
function sumItems(items, ref, label) {
  if (!items.length) throw AppError.unprocessable('Não há valores para somar.', 'AI_NUMBER_NOT_FROM_SOURCE');
  return { ref, label, value: sumExact(items.map((i) => i.value), 2), unit: items[0].unit, source: items.map((i) => i.source).join('+'), asOf: items[0].asOf };
}

/** Tool de leitura: exige finance:read do ator e devolve o payload com `asOf`. */
async function getFinanceNumbers(ctx, transaction) {
  const permissions = Array.isArray(ctx && ctx.permissions) ? ctx.permissions : [];
  if (!permissions.includes(PERMISSAO)) {
    throw AppError.forbidden('Você não tem permissão para consultar números financeiros.', 'PERMISSION_DENIED', { required: PERMISSAO });
  }
  return itemsFromReport(await financeHealth(transaction).getWeekly());
}

module.exports = { getFinanceNumbers, numbersFromToolOutput, itemsFromReport, itemsFromDelinquency, sumItems, SOURCE };
