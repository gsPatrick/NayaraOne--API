'use strict';

const { Op } = require('sequelize');
const { sequelize, Group, Company, PaymentIntent } = require('../../models');
const { reconcilePaymentIntent } = require('../../features/finance/bankPayments.service');
const bank = require('../../features/finance/bank');

// B2 (revisão independente, conferência Nayara 18/10/2026): getPaymentStatus existia no adapter
// mas nada o chamava — uma intenção com resposta incerta do banco (SUBMITTING) ou em trânsito
// (SUBMITTED) ficava presa para sempre. Este job consulta o banco para cada uma delas
// (idempotente: confirmBankPayment só age enquanto a intenção está incerta/em trânsito).

async function reconcileCompany(group, company) {
  const candidates = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)', {
      replacements: { g: group.id, c: company.id },
      transaction,
    });
    // M9-D237: idade mínima da consulta é parâmetro da empresa (integration.bank.reconcile_min_age_min, padrão 2 minutos).
    const { reconcileMinAgeMin } = await bank.readBankParams({ groupId: group.id, companyId: company.id }, transaction);
    return PaymentIntent.findAll({
      where: { status: ['SUBMITTING', 'SUBMITTED'], updatedAt: { [Op.lt]: new Date(Date.now() - reconcileMinAgeMin * 60 * 1000) } },
      transaction,
    });
  });
  const summary = { checked: 0, resolved: 0, errors: 0 };
  for (const candidate of candidates) {
    summary.checked += 1;
    try {
      const result = await sequelize.transaction(async (transaction) => {
        await sequelize.query('SELECT set_config(\'app.group_id\', :g, true), set_config(\'app.company_id\', :c, true)', {
          replacements: { g: group.id, c: company.id },
          transaction,
        });
        return reconcilePaymentIntent(candidate.id, { userId: null }, transaction);
      });
      if (['EXECUTED', 'FAILED'].includes(result.intent.status)) summary.resolved += 1;
    } catch (err) {
      summary.errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[BankPaymentReconciliationJob] Falha na intenção ${candidate.id}: ${err.message}`);
    }
  }
  // M9-D237: depois de consultar o status de cada pagamento, lê o extrato do banco (cursor) e concilia as saídas com os pagamentos enviados.
  try {
    const extrato = await bank.sweepStatements({ group, company });
    const conciliacao = await bank.reconcileStatements({ group, company });
    Object.assign(summary, { statementImported: extrato.imported, statementReconciled: conciliacao.reconciled, statementMismatched: conciliacao.mismatched });
  } catch (err) {
    summary.errors += 1;
    // eslint-disable-next-line no-console
    console.error(`[BankPaymentReconciliationJob] Falha no extrato da empresa ${company.id}: ${err.message}`);
  }
  return summary;
}

async function runBankPaymentReconciliationJob() {
  const groups = await Group.findAll();
  const total = { companies: 0, checked: 0, resolved: 0, errors: 0, statementImported: 0, statementReconciled: 0, statementMismatched: 0 };
  for (const group of groups) {
    const companies = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SET LOCAL app.group_id = :groupId', { replacements: { groupId: group.id }, transaction });
      return Company.findAll({ transaction });
    });
    for (const company of companies) {
      total.companies += 1;
      const r = await reconcileCompany(group, company);
      total.checked += r.checked;
      total.resolved += r.resolved;
      total.errors += r.errors;
      total.statementImported += r.statementImported || 0;
      total.statementReconciled += r.statementReconciled || 0;
      total.statementMismatched += r.statementMismatched || 0;
    }
  }
  return total;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

function startBankPaymentReconciliationJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  return setInterval(() => {
    runBankPaymentReconciliationJob().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[BankPaymentReconciliationJob] Falha na execução agendada:', err.message);
    });
  }, intervalMs);
}

module.exports = { runBankPaymentReconciliationJob, startBankPaymentReconciliationJob, reconcileCompany };
