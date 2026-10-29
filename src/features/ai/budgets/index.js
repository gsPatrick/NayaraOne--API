'use strict';

const { reserve, settle, release, spendWithBudget } = require('./budgets.gate');
const { budgetPolicy } = require('./budgets.policy');
const { listBudgets, createBudget, updateBudget } = require('./budgets.admin.service');
const { readBudgetParams } = require('./budgets.params');
const { rolloverCompany } = require('./budgets.rollover');
const { estimateCost } = require('./budgets.money');
const settings = require('./budgets.settings');

/** Orçamento de uso da NAY (M9-D014): reserva antes de gastar, alertas por limiar, política de degradação e virada de mês. */
module.exports = {
  reserve, settle, release, spendWithBudget, budgetPolicy, listBudgets, createBudget, updateBudget, readBudgetParams, rolloverCompany, estimateCost, ...settings,
};
