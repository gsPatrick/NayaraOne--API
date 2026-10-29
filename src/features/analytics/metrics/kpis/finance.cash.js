'use strict';

/**
 * M9-D620 — definição e entrada de cálculo dos KPIs fin.free_cash (Caixa livre por empresa) e fin.third_party_cash (Dinheiro de terceiros), versão 1.
 * Os 15 campos do livro (M9-D603): fonte rm_finance_health, fórmula versionada no código (formulas/finFreeCash.js e finThirdPartyCash.js, id
 * igual ao código do indicador, como manda a tabela de criticidade da M9-D712), dimensões, unidade BRL, owner (parâmetro analytics.owner.<código>), política de atualização (evento + agenda de 15 min, M9-D607) e
 * regra de qualidade. Os dois são CRITICAL (dinheiro, bloco 3 e 4; BI-005): nascem com drill-down.
 */
const { readCashOwner } = require('../../read-models/cash.settings');

const REFERENCE_REPORT = 'Relatório de conciliação de KPIs do Financeiro (M9-D708): caixa e dinheiro de terceiros conforme o Financeiro e a conciliação bancária';
const MAX_STALENESS_MINUTES = 15;

const DEFINITIONS = Object.freeze([
  {
    metricCode: 'fin.free_cash', name: 'Caixa livre por empresa', formulaId: 'fin.free_cash', valueNature: 'ACTUAL', unit: 'BRL', criticality: 'CRITICAL', drilldownEnabled: true,
    description: 'Dinheiro que a empresa pode de fato usar no fim do dia-base: caixa total (lançamentos liquidados, transferências entre empresas e saldo de abertura) menos o dinheiro de terceiros retido (caução e repasses).',
    formulaSemantic: 'caixaTotal = Σ lançamentos SETTLED da empresa (receber menos pagar, próprios e de terceiros, estornos fora) + transferências entre empresas liquidadas + saldo de abertura das contas (se ligado); terceirosRetidos = entradas SETTLED de terceiros menos devoluções e compensações; freeCash = caixaTotal - terceirosRetidos. Posição no fim do dia-base de São Paulo; arredonda uma vez, 2 casas.',
    dimensions: ['empresa', 'conta bancária', 'centro de custo'],
    qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: MAX_STALENESS_MINUTES, requiredFields: ['reconciliation_gap', 'manual_review_pending'], allowNull: true },
  },
  {
    metricCode: 'fin.third_party_cash', name: 'Dinheiro de terceiros', formulaId: 'fin.third_party_cash', valueNature: 'ACTUAL', unit: 'BRL', criticality: 'CRITICAL', drilldownEnabled: true,
    description: 'Dinheiro que passa pela conta da imobiliária mas tem dono (caução, repasse ao proprietário e outros): recebido menos devolvido ou compensado. Nunca entra no caixa livre.',
    formulaSemantic: 'Σ entradas SETTLED de terceiros menos Σ devoluções (RETURN) e compensações (COMPENSATION) SETTLED, por empresa, até o fim do dia-base de São Paulo; detalhe por origem (caução, repasse, outro) pela referência do lançamento.',
    dimensions: ['empresa', 'origem', 'pessoa detentora'],
    qualityRule: { referenceReport: REFERENCE_REPORT, maxStalenessMinutes: MAX_STALENESS_MINUTES, requiredFields: ['third_party_inflow'], allowNull: true },
  },
]);

const CODES = DEFINITIONS.map((d) => d.metricCode);

/** Owner do KPI de caixa (parâmetro analytics.owner.<código>); nulo para os códigos que não são destes dois KPIs. */
const ownerOf = async (code, scope, transaction) => (CODES.includes(code) ? readCashOwner(code, scope, transaction) : null);

/** O parâmetro "usar saldo de abertura" vigente no cálculo do read model fica guardado nos critérios da origem (source_criteria), para o KPI e o detalhe usarem o mesmo. */
const includesOpening = (row) => ((((row.source_criteria || {})['fin.free_cash'] || {}).equals) || {}).includeOpening !== false;

/** O read model guarda o critério do caixa livre (parte própria do ledger: thirdParty = false); o KPI confere que ele foi aplicado. */
const ownFundsOnly = (row) => ((((row.source_criteria || {})['fin.free_cash'] || {}).equals) || {}).thirdParty === false;

const INPUTS = Object.freeze({
  'fin.free_cash': (row, asOfDate) => ({
    asOfDate, ledgerFilter: { is_third_party_funds: ownFundsOnly(row) ? false : null }, totalCash: String(row.total_cash), thirdPartyRetained: String(row.third_party_cash), openingBalance: String(row.opening_balance_total),
    includeOpening: includesOpening(row),
    intercompanyNet: String(row.intercompany_cash_net), byAccount: row.cash_by_bank_account || {}, byCostCenter: row.cash_by_cost_center || {},
    manualReviewPending: row.manual_review_pending, reconciliationGap: row.reconciliation_gap === null || row.reconciliation_gap === undefined ? null : String(row.reconciliation_gap),
    reconciliationAccounts: row.reconciliation_gap_accounts,
  }),
  'fin.third_party_cash': (row, asOfDate) => ({
    asOfDate, inflow: String(row.third_party_inflow), returned: String(row.third_party_returned), compensated: String(row.third_party_compensated), byOrigin: row.third_party_by_origin || {},
  }),
});

module.exports = { DEFINITIONS, INPUTS, ownerOf };
