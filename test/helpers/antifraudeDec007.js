'use strict';

// Apoio aos testes do antifraude da DEC-007 (rodada 2): conta de destino, histórico liquidado, pagamento pelo serviço real, casos abertos e o catálogo de
// parâmetros (parametros.csv) transcrito, para o teste não depender do código que ele confere. Não é teste.
const T = require('../testHelpers');
const bankAccountsService = require('../../src/modules/finance/application/services/bank-accounts.service');
const financialEntriesService = require('../../src/modules/finance/application/services/financial-entry.service');
const { AnomalyCase, FinancialEntry, TenantSetting } = require('../../src/models');

// Catálogo X45-D101 (Maturacao/demandas/parametros.csv, DEC-007): chave -> [padrão, mínimo, máximo, inteiro, rótulo]. As duas últimas são a regra de
// conciliação manual por empresa que já existia (finance-settings.js), com a faixa do dicionário.
const CATALOGO = Object.freeze({
  'antifraude.duplicidade_janela_dias': [90, 1, 365, true, 'Pagamento duplicado: janela de dias'],
  'antifraude.fornecedor_novo_dias': [30, 1, 365, true, 'Fornecedor novo: dias de cadastro'],
  'antifraude.fornecedor_novo_valor_minimo': [20000, 0.01, 999999999.99, false, 'Fornecedor novo: valor a partir do qual exige verificação'],
  'antifraude.outlier_bloqueio_multiplicador': [10, 1, 1000, false, 'Valor fora do padrão: múltiplo que bloqueia'],
  'antifraude.outlier_amostra_minima': [5, 1, 100, true, 'Valor fora do padrão: mínimo de pagamentos no histórico'],
  'antifraude.outlier_historico_meses': [12, 1, 60, true, 'Valor fora do padrão: meses de histórico'],
  'antifraude.conciliacao_manual_usuario_7d': [5, 1, 100, true, 'Conciliação manual recorrente: por usuário em 7 dias'],
  'antifraude.conciliacao_manual_percentual_mes': [30, 1, 100, false, 'Conciliação manual recorrente: percentual do mês'],
  'antifraude.estorno_frequente_usuario_30d': [3, 1, 100, true, 'Estorno frequente: por usuário em 30 dias'],
  'antifraude.estorno_frequente_empresa_30d': [5, 1, 1000, true, 'Estorno frequente: por empresa em 30 dias'],
  'finance.bank_account_cooldown_hours': [48, 0, 720, true, 'Conta bancária nova: horas de espera'],
  'finance.antifraud_new_account_threshold': [5000, 0, 999999999.99, false, 'Conta nova: valor a partir do qual exige aprovação extra'],
  'finance.antifraud_history_multiplier': [3, 1, 100, false, 'Valor fora do padrão: múltiplo da mediana que exige revisão'],
  'finance.antifraud_manual_reconciliation_min_count': [3, 1, 100, true, 'Conciliação manual recorrente: conciliações à mão na empresa no período'],
  'finance.antifraud_manual_reconciliation_window_days': [30, 1, 365, true, 'Conciliação manual recorrente: período considerado (dias)'],
});
const MFA_KEYS = Object.freeze(['finance.bank_account_cooldown_hours', 'finance.antifraud_new_account_threshold']);

/** Valores gravados que não são número válido na faixa da chave (todos devem valer como o padrão). */
function invalidStoredValues(key) {
  const [, min, max, integer] = CATALOGO[key];
  const out = ['', false, true, [], [7], {}, 'abc', String(min + 1), -5, min - 1, max + 1];
  if (min > 0) out.push(0);
  if (integer) out.push(min + 0.5);
  return out;
}

function kit(getTenant) {
  const base = () => ({ groupId: getTenant().groupId, companyId: getTenant().companyId });
  const tenantUser = () => getTenant().userId;

  async function account(t, { ageDays = 0, status = 'ACTIVE' } = {}) {
    const acc = await bankAccountsService.createBankAccount({ ...base(), bankCode: '341', agency: '0001', accountNumber: `${T.uniqueSuffix()}` }, tenantUser(), t);
    if (status !== acc.status) { acc.status = status; await acc.save({ transaction: t }); }
    if (ageDays) await T.sequelize.query("UPDATE finance.bank_accounts SET created_at = now() - (:d || ' days')::interval WHERE id = :id", { replacements: { d: String(ageDays), id: acc.id }, transaction: t });
    return acc;
  }

  /** Pagamentos já liquidados ao favorecido (`bankAccountId`), na categoria `chartOfAccountId` (nula = sem plano de contas), `monthsAgo` meses atrás. */
  async function settled(t, bankAccountId, amounts, { costCenterId, chartOfAccountId = null, monthsAgo = 0 } = {}) {
    const when = new Date();
    when.setMonth(when.getMonth() - monthsAgo);
    const rows = [];
    for (const amount of amounts) {
      rows.push(await FinancialEntry.create({ ...base(), bankAccountId, costCenterId, chartOfAccountId, entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `histórico ${T.uniqueSuffix()}`, status: 'SETTLED', settledAt: when, competenceMonth: when.toISOString().slice(0, 7) }, { transaction: t }));
    }
    return rows;
  }

  const payable = (t, amount, extra = {}) => financialEntriesService.createFinancialEntry({ ...base(), entryType: 'DEBIT', nature: 'PAYABLE', amount, description: `DEC-007 ${amount} ${T.uniqueSuffix()}`, ...extra }, tenantUser(), t);
  const casesOf = async (t, entryId) => (await AnomalyCase.findAll({ where: { relatedEntityType: 'FinancialEntry', relatedEntityId: entryId }, order: [['caseType', 'ASC']], transaction: t })).map((c) => `${c.caseType}:${c.riskLevel}`);
  const store = (t, key, value) => TenantSetting.create({ ...base(), key, value }, { transaction: t });
  const unstore = (t, key) => TenantSetting.destroy({ where: { companyId: getTenant().companyId, key }, force: true, transaction: t });

  return { base, account, settled, payable, casesOf, store, unstore };
}

module.exports = { CATALOGO, MFA_KEYS, invalidStoredValues, kit };
