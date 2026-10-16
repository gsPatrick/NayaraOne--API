'use strict';

const { Op } = require('sequelize');
const { BudgetForecast, FinancialEntry } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

const NATURES = ['PAYABLE', 'RECEIVABLE'];
const COMPETENCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * budgetsForecasts.service.js — GAP REAL CORRIGIDO (Caderno §5, "finance.budgets_forecasts" /
 * "Orçamento/projeção"). CRUD mínimo + comparação contra o realizado: o realizado nunca é
 * duplicado aqui, é lido direto de finance.financial_entries (SETTLED, mesmo critério usado no
 * relatório semanal — ver financialHealthReport.service.js).
 */
async function createBudgetForecast(payload, actorUserId, transaction) {
  const { groupId, companyId, competenceMonth, nature, costCenterId, resultCenterId, description, forecastedAmount } = payload;
  if (!groupId || !companyId || !competenceMonth || !nature || forecastedAmount === undefined || forecastedAmount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "competenceMonth", "nature" e "forecastedAmount" são obrigatórios.',
      'FINANCE_BUDGET_FORECAST_VALIDATION'
    );
  }
  if (!COMPETENCE_MONTH_REGEX.test(competenceMonth)) {
    throw AppError.badRequest('O campo "competenceMonth" deve estar no formato "YYYY-MM".', 'FINANCE_BUDGET_FORECAST_VALIDATION');
  }
  const normalizedNature = String(nature).toUpperCase();
  if (!NATURES.includes(normalizedNature)) {
    throw AppError.badRequest(`O campo "nature" deve ser um de: ${NATURES.join(', ')}.`, 'FINANCE_BUDGET_FORECAST_VALIDATION');
  }
  const amountNumeric = Number(forecastedAmount);
  if (!Number.isFinite(amountNumeric) || amountNumeric <= 0) {
    throw AppError.badRequest('O campo "forecastedAmount" deve ser um número positivo.', 'FINANCE_BUDGET_FORECAST_VALIDATION');
  }
  if (normalizedNature === 'PAYABLE' && !costCenterId) {
    throw AppError.badRequest('Projeção de despesa (nature "PAYABLE") exige "costCenterId".', 'FINANCE_BUDGET_FORECAST_COST_CENTER_REQUIRED');
  }
  if (normalizedNature === 'RECEIVABLE' && !resultCenterId) {
    throw AppError.badRequest('Projeção de receita (nature "RECEIVABLE") exige "resultCenterId".', 'FINANCE_BUDGET_FORECAST_RESULT_CENTER_REQUIRED');
  }

  const forecast = await BudgetForecast.create(
    {
      groupId,
      companyId,
      competenceMonth,
      nature: normalizedNature,
      costCenterId: costCenterId || null,
      resultCenterId: resultCenterId || null,
      description: description || null,
      forecastedAmount: round2(amountNumeric),
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.budget_forecast.create',
      entityType: 'BudgetForecast',
      entityId: forecast.id,
      afterJson: forecast.toJSON(),
      reason: `Projeção ${normalizedNature} de ${competenceMonth}: ${description || ''}`.trim(),
    },
    transaction
  );

  return forecast;
}

async function listBudgetForecasts(transaction, filters = {}) {
  const where = {};
  if (filters.competenceMonth) where.competenceMonth = filters.competenceMonth;
  if (filters.nature) where.nature = String(filters.nature).toUpperCase();
  if (filters.costCenterId) where.costCenterId = filters.costCenterId;
  if (filters.resultCenterId) where.resultCenterId = filters.resultCenterId;
  return BudgetForecast.findAll({ where, order: [['competence_month', 'DESC']], transaction });
}

/**
 * compareForecastToRealized — orçado (soma das BudgetForecast do mês) x realizado (soma de
 * FinancialEntry SETTLED no mesmo competenceMonth, mesma natureza, não-terceiro).
 */
async function compareForecastToRealized(competenceMonth, transaction) {
  if (!COMPETENCE_MONTH_REGEX.test(competenceMonth)) {
    throw AppError.badRequest('O campo "competenceMonth" deve estar no formato "YYYY-MM".', 'FINANCE_BUDGET_FORECAST_VALIDATION');
  }

  const forecasts = await BudgetForecast.findAll({ where: { competenceMonth }, transaction });
  const realized = await FinancialEntry.findAll({
    where: {
      competenceMonth,
      status: 'SETTLED',
      isThirdPartyFunds: false,
      nature: { [Op.in]: NATURES },
    },
    attributes: ['amount', 'nature'],
    transaction,
  });

  const forecastedByNature = { PAYABLE: 0, RECEIVABLE: 0 };
  for (const f of forecasts) forecastedByNature[f.nature] += toNumber(f.forecastedAmount);

  const realizedByNature = { PAYABLE: 0, RECEIVABLE: 0 };
  for (const e of realized) realizedByNature[e.nature] += toNumber(e.amount);

  return NATURES.map((nature) => ({
    nature,
    forecasted: round2(forecastedByNature[nature]),
    realized: round2(realizedByNature[nature]),
    variance: round2(realizedByNature[nature] - forecastedByNature[nature]),
  }));
}

module.exports = {
  createBudgetForecast,
  listBudgetForecasts,
  compareForecastToRealized,
  NATURES,
};
