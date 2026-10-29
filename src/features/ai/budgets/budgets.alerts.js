'use strict';

const { Notification } = require('../../../models');
const repo = require('../readmodels/budgetSupport.readmodel');
const { reaches, pctOf } = require('./budgets.money');
const { publishBudgetThreshold } = require('../events');
const { PERMISSIONS } = require('./budgets.constants');

const brl = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "da empresa", "do agente X" ou "do agente X e modelo SMALL". */
function scopeLabel(b) {
  if (b.agentCode && b.modelClass) return `do agente ${b.agentCode} (modelo ${b.modelClass})`;
  if (b.agentCode) return `do agente ${b.agentCode}`;
  if (b.modelClass) return `do modelo ${b.modelClass}`;
  return 'da empresa';
}

function alertMessage(b, threshold) {
  return `O orçamento de IA ${scopeLabel(b)} chegou a ${threshold}%: R$ ${brl(b.consumedAmount)} de R$ ${brl(b.limitAmount)}.`;
}

async function notifyBudgetOwners(ctx, b, threshold, transaction) {
  const users = await repo.usersWithPermission(b, PERMISSIONS.edit, transaction);
  for (const userId of users) {
    await Notification.create({
      groupId: b.groupId, companyId: b.companyId, userId, channel: 'IN_APP', title: `Orçamento de IA em ${threshold}%`,
      body: alertMessage(b, threshold), createdBy: null, updatedBy: null,
    }, { transaction });
  }
  return users.length;
}

/**
 * Depois de um consumo: para cada limiar já alcançado grava o alerta (UNIQUE budget_id+limiar+período; só quem inseriu publica o
 * evento e avisa quem tem ai:budget). Duas conexões cruzando o mesmo limiar geram um alerta, um evento e um aviso.
 * `thresholds` vem da linha (se preenchida) ou do parâmetro da empresa.
 */
async function raiseAlerts(ctx, budget, paramThresholds, transaction) {
  const thresholds = Array.isArray(budget.thresholds) && budget.thresholds.length ? budget.thresholds : paramThresholds;
  const raised = [];
  for (const threshold of thresholds) {
    if (!reaches(budget.consumedAmount, budget.limitAmount, threshold)) continue;
    const pct = pctOf(budget.consumedAmount, budget.limitAmount);
    if (!(await repo.insertAlert(budget, threshold, pct, transaction))) continue;
    await publishBudgetThreshold(budget, threshold, pct, transaction);
    await notifyBudgetOwners(ctx, budget, threshold, transaction);
    raised.push(threshold);
  }
  return raised;
}

module.exports = { raiseAlerts, alertMessage, scopeLabel };
