'use strict';

const { Op } = require('sequelize');
const { IntercompanyTransfer, Company, FinancialEntry } = require('../../../../models');
const AppError = require('../../../../utils/AppError');
const { setCompanyContext, actorCanReadFinanceIn } = require('./intercompany-company-context');

function toCents(value) {
  return Math.round(Number(value) * 100);
}

/**
 * getGroupConsolidatedReport — "Consolidado Diretoria — somente visão; não mistura ledger nem
 * saldos; agrega relatórios" (§3) + "Relatório consolidado elimina a duplicidade apenas na
 * apresentação" (§15). Para cada empresa do grupo em que o usuário tem `finance:read`, soma os
 * lançamentos (exceto cancelados, estornados, estornos e baixas-filhas) e, no consolidado,
 * elimina os dois lados de cada transferência intercompany aprovada cujas DUAS empresas estão no
 * relatório. Empresas sem permissão ficam de fora e são listadas em `excludedCompanies`.
 */
async function getGroupConsolidatedReport(actor, filters, transaction) {
  const { groupId, companyId: currentCompanyId, userId } = actor;
  const referenceMonth = filters && filters.referenceMonth ? String(filters.referenceMonth) : null;
  if (referenceMonth && !/^\d{4}-\d{2}$/.test(referenceMonth)) {
    throw AppError.badRequest('O mês de referência precisa estar no formato mês/ano (ex.: 10/2026).', 'FINANCE_CONSOLIDATED_VALIDATION');
  }

  const companies = await Company.findAll({ where: { groupId }, order: [['name', 'ASC']], transaction });
  const included = [];
  const excludedCompanies = [];
  const transfers = [];

  try {
    for (const company of companies) {
      // eslint-disable-next-line no-await-in-loop
      await setCompanyContext(company.id, transaction);
      // eslint-disable-next-line no-await-in-loop
      if (!(await actorCanReadFinanceIn(company.id, userId, transaction))) {
        excludedCompanies.push({ companyId: company.id, name: company.name, reason: 'Sem permissão finance:read nesta empresa.' });
        continue; // eslint-disable-line no-continue
      }
      const where = {
        companyId: company.id,
        status: { [Op.notIn]: ['CANCELLED', 'REVERSED'] },
        reversalOfEntryId: null,
        parentEntryId: null,
      };
      if (referenceMonth) where.competenceMonth = referenceMonth;
      // eslint-disable-next-line no-await-in-loop
      const entries = await FinancialEntry.findAll({ where, attributes: ['id', 'entryType', 'amount'], transaction });
      // eslint-disable-next-line no-await-in-loop
      const companyTransfers = await IntercompanyTransfer.findAll({
        where: { companyId: company.id, status: ['PENDING', 'RECONCILED'] },
        transaction,
      });
      transfers.push(...companyTransfers);
      included.push({ company, entries });
    }
  } finally {
    await setCompanyContext(currentCompanyId, transaction);
  }

  const includedIds = new Set(included.map((i) => i.company.id));
  const eliminatedEntryIds = new Set();
  const eliminations = [];
  for (const transfer of transfers) {
    if (includedIds.has(transfer.fromCompanyId) && includedIds.has(transfer.toCompanyId)) {
      eliminatedEntryIds.add(transfer.fromEntryId);
      eliminatedEntryIds.add(transfer.toEntryId);
      eliminations.push({
        transferId: transfer.id,
        fromCompanyId: transfer.fromCompanyId,
        toCompanyId: transfer.toCompanyId,
        amount: toCents(transfer.amount) / 100,
      });
    }
  }

  let consolidatedCredits = 0;
  let consolidatedDebits = 0;
  const companiesOut = included.map(({ company, entries }) => {
    let credits = 0;
    let debits = 0;
    let intercompanyCredits = 0;
    let intercompanyDebits = 0;
    for (const entry of entries) {
      const cents = toCents(entry.amount);
      const isCredit = entry.entryType === 'CREDIT';
      if (isCredit) credits += cents; else debits += cents;
      if (eliminatedEntryIds.has(entry.id)) {
        if (isCredit) intercompanyCredits += cents; else intercompanyDebits += cents;
      } else if (isCredit) {
        consolidatedCredits += cents;
      } else {
        consolidatedDebits += cents;
      }
    }
    return {
      companyId: company.id,
      name: company.name,
      totalCredits: credits / 100,
      totalDebits: debits / 100,
      intercompanyCredits: intercompanyCredits / 100,
      intercompanyDebits: intercompanyDebits / 100,
    };
  });

  return {
    groupId,
    referenceMonth,
    companies: companiesOut,
    eliminations,
    consolidated: {
      totalCredits: consolidatedCredits / 100,
      totalDebits: consolidatedDebits / 100,
      net: (consolidatedCredits - consolidatedDebits) / 100,
    },
    excludedCompanies,
  };
}

module.exports = {
  getGroupConsolidatedReport,
};
