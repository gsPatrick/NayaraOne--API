'use strict';

const { Op } = require('sequelize');
const {
  sequelize,
  Project,
  ProjectStage,
  StageMeasurement,
  BudgetLine,
  FinancialEntry,
  ChangeOrder,
  LossRecord,
  Nonconformity,
  InventoryMovement,
  InventoryItem,
} = require('../../models');
const AppError = require('../../utils/AppError');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { RULE_CODE: MARGIN_RULE_CODE } = require('./marginRules.service');

// M6-42/M6-99 — read model de custo/saúde da obra. Cálculo REAL sobre dados já existentes no
// banco (nenhum número inventado): tudo aqui é soma/derivação de linhas reais, lida sob o RLS
// da empresa do contexto (mesma filosofia de financialHealthReport.service.js, M4-20).
//
// GET /construction/projects/:id/health devolve os 9 campos pedidos pelo escopo do Marco 6
// (M6-42) mais um conjunto de KPIs adicionais (M6-99) que dependem só de dados sob controle
// desta fatia (medição/etapa). Campos que dependem de outras fatias em paralelo (Change Orders,
// custo de estoque) são calculados com fallback documentado — nunca quebram o endpoint.

function toNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * getConsumedInventoryCost — GAP CORRIGIDO (auditoria pós-Marco 6, item 3): o custo de estoque
 * consumido pela obra ficava hard-coded em 0 porque não havia vínculo projectId nos movimentos
 * de estoque. Agora `inventory.inventory_movements.project_id` existe (EST-004) e
 * `inventory.inventory_items.average_cost` já é mantido pelo módulo de Estoque — soma-se o
 * custo real: saídas (OUT) debitam ao custo médio do item no momento da consulta, devoluções
 * (RETURN) e perdas revertidas abatem. Não inventa custo unitário por movimento (o schema não
 * guarda isso): usa o custo médio ATUAL do item, mesma fonte usada no restante do sistema.
 */
async function getConsumedInventoryCost(projectId, transaction) {
  const movements = await InventoryMovement.findAll({
    where: { projectId, movementType: { [Op.in]: ['OUT', 'RETURN'] } },
    transaction,
  });
  if (movements.length === 0) return 0;

  const itemIds = [...new Set(movements.map((m) => m.inventoryItemId))];
  const items = await InventoryItem.findAll({ where: { id: { [Op.in]: itemIds } }, transaction });
  const costById = new Map(items.map((i) => [i.id, toNumber(i.averageCost)]));

  return movements.reduce((acc, m) => {
    const unitCost = costById.get(m.inventoryItemId) || 0;
    const sign = m.movementType === 'RETURN' ? -1 : 1;
    return acc + sign * toNumber(m.quantity) * unitCost;
  }, 0);
}

/**
 * getApprovedChangeOrdersTotal — M6-97/M6-42: soma de change orders aprovados da obra.
 * CORRIGIDO em 30/09/2026 (auditoria pós-merge): a versão anterior consultava a tabela
 * inexistente `construction.construction_change_orders`, caindo sempre no catch e retornando
 * 0 silenciosamente mesmo com Change Orders aprovados de verdade. A tabela real, criada pela
 * fatia de orçamento/baseline, é `construction.change_orders` com coluna `budget_impact`
 * (model `ChangeOrder`) — usa o model Sequelize diretamente, não SQL ad-hoc.
 */
async function getApprovedChangeOrdersTotal(projectId, transaction) {
  const total = await ChangeOrder.sum('budgetImpact', {
    where: { projectId, status: 'APPROVED' },
    transaction,
  });
  return toNumber(total);
}

async function getProject(id, transaction) {
  const project = await Project.findByPk(id, { transaction });
  if (!project) throw AppError.notFound('Obra não encontrada.', 'PROJECT_NOT_FOUND');
  return project;
}

/**
 * getProjectHealth — os 9 campos do M6-42 + KPIs adicionais do M6-99.
 *
 *  1. baselineBudget         — construction.projects.budget_amount (orçamento base aprovado da
 *                               obra); se nulo, soma construction.budget_lines.planned_amount.
 *  2. approvedChanges        — soma de Change Orders APROVADOS (fatia em paralelo — ver acima).
 *  3. committedCost          — soma de construction.budget_lines.planned_amount (o que já foi
 *                               comprometido/orçado por linha de custo).
 *  4. actualFinancialCost    — soma de finance.financial_entries SETTLED (nature=PAYABLE,
 *                               construction_project_id = obra) — dinheiro que JÁ SAIU de fato.
 *  5. consumedInventoryCost  — TODO: inventory.inventory_movements não tem custo unitário no
 *                               schema atual (InventoryItem/InventoryMovement não carregam
 *                               unit_cost) — sem uma fatia de custeio de estoque, este valor
 *                               fica 0 (documentado, não inventado).
 *  6. forecastToComplete     — max(committedCost + approvedChanges - actualFinancialCost, 0).
 *  7. projectedTotalCost     — actualFinancialCost + forecastToComplete.
 *  8. projectedMargin        — (baselineBudget + approvedChanges) - projectedTotalCost.
 *  9. updatedAt              — timestamp do cálculo (ISO 8601) — é um read model, não uma
 *                               tabela materializada, então "updatedAt" é sempre "agora".
 *
 * + marginPct/minMarginPct/belowMinMargin (FIX 01/10/2026): "Margem abaixo da regra gera
 *   alerta" (fonte, seção 5) — marginPct = projectedMargin / (baselineBudget + approvedChanges)
 *   * 100; minMarginPct vem da MarginRule ativa da empresa; belowMinMargin = marginPct <
 *   minMarginPct. Qualquer um fica `null` se faltar base (sem orçamento ainda) ou regra ativa —
 *   nunca bloqueia o endpoint, é só o sinal pro alerta no front.
 */
async function getProjectHealth(projectId, transaction) {
  const project = await getProject(projectId, transaction);

  const [stages, budgetLines, settledEntries, pendingEntries] = await Promise.all([
    ProjectStage.findAll({ where: { projectId }, transaction }),
    BudgetLine.findAll({ where: { projectId }, transaction }),
    FinancialEntry.findAll({
      where: { constructionProjectId: projectId, nature: 'PAYABLE', status: { [Op.in]: ['SETTLED', 'PARTIALLY_SETTLED'] } },
      transaction,
    }),
    FinancialEntry.findAll({
      where: { constructionProjectId: projectId, nature: 'PAYABLE', status: 'PENDING' },
      transaction,
    }),
  ]);

  const stageIds = stages.map((s) => s.id);
  const measurements = stageIds.length
    ? await StageMeasurement.findAll({ where: { projectStageId: { [Op.in]: stageIds } }, transaction })
    : [];

  const committedCost = budgetLines.reduce((acc, line) => acc + toNumber(line.plannedAmount), 0);
  const baselineBudget = project.budgetAmount !== null && project.budgetAmount !== undefined
    ? toNumber(project.budgetAmount)
    : committedCost;

  const approvedChanges = await getApprovedChangeOrdersTotal(projectId, transaction);

  // actualFinancialCost: valor JÁ pago. Baixas parciais (status PARTIALLY_SETTLED) contam só a
  // fração já liquidada, nunca o valor total do lançamento pai — buscamos as baixas (linhas
  // filhas SETTLED com parent_entry_id) para não superestimar o que já saiu.
  const settledIds = settledEntries.map((e) => e.id);
  const partialSettlements = settledIds.length
    ? await FinancialEntry.findAll({
        where: { parentEntryId: { [Op.in]: settledIds }, status: 'SETTLED' },
        transaction,
      })
    : [];
  const actualFinancialCost = settledEntries.reduce((acc, entry) => {
    if (entry.status === 'SETTLED') return acc + toNumber(entry.amount);
    return acc; // PARTIALLY_SETTLED: soma-se só pelas baixas filhas abaixo
  }, 0) + partialSettlements.reduce((acc, s) => acc + toNumber(s.amount), 0);

  // consumedInventoryCost — ver getConsumedInventoryCost() (GAP CORRIGIDO, ver comentário acima).
  const consumedInventoryCost = await getConsumedInventoryCost(projectId, transaction);

  const forecastToComplete = Math.max(committedCost + approvedChanges - actualFinancialCost, 0);
  const projectedTotalCost = round2(actualFinancialCost + forecastToComplete);
  // BUG REAL CORRIGIDO (auditoria E2E ao vivo, Marco 6, Ciclo 4, 2026-10-06): projectedMargin
  // somava `baselineBudget + approvedChanges`, mas `baselineBudget` (quando vem de
  // project.budgetAmount) JÁ inclui o impacto dos Change Orders aprovados — changeOrders.
  // service.js:decideChangeOrder sincroniza project.budgetAmount com o novo baseline no momento
  // da aprovação (comentário na linha ~177 desse arquivo confirma a intenção). Somar
  // approvedChanges de novo aqui inflava a margem projetada, podendo mascarar um alerta de
  // margem abaixo da regra configurada que deveria ter disparado. Base de margem usa
  // committedCost (soma das linhas de orçamento, nunca tocada por Change Order) + approvedChanges
  // — mesma base já usada em forecastToComplete, nunca double-counta.
  const marginBudgetBase = committedCost + approvedChanges;
  const projectedMargin = round2(marginBudgetBase - projectedTotalCost);

  // marginPct/belowMinMargin (FIX 01/10/2026, achado em auditoria): a fonte ("CONSTRUÇÃO +
  // OBRAS + PÓS-OBRA — BLINDADO v1", seção 5) exige "Margem abaixo da regra gera alerta" — o
  // relatório de saúde é o lugar documentado para esse alerta (não um bloqueio em
  // approveBudget, que só precisa existir uma regra ativa e congelar sua versão — já feito em
  // budgets.service.js). Percentual calculado sobre a receita-base da obra (baseline + changes);
  // sem receita-base (projeto ainda sem orçamento/linha) ou sem regra ativa configurada, os
  // campos ficam `null` — nunca inventa denominador nem bloqueia o endpoint (fail-open, é um
  // read model).
  const marginPct = marginBudgetBase > 0 ? round2((projectedMargin / marginBudgetBase) * 100) : null;
  // GAP CORRIGIDO (auditoria pós-Marco 6, item 4): minMarginPct vinha de `MarginRule` (tabela
  // dedicada do módulo), agora vem do Motor de Regras genérico (REG-OBR-001 — ver
  // marginRules.service.js para a decisão de migração completa).
  const marginEvaluation = await evaluateRule(
    MARGIN_RULE_CODE,
    { marginRuleActive: true },
    { groupId: project.groupId, companyId: project.companyId },
    { transaction }
  );
  const minMarginPct = marginEvaluation.decision === 'APPLY' ? Number(marginEvaluation.action.minMarginPct) : null;
  const belowMinMargin = marginPct !== null && minMarginPct !== null ? marginPct < minMarginPct : null;

  // --- KPIs adicionais (M6-99) — só os que dependem de dados desta fatia (medição/etapa). ---
  const avgMeasuredPct = stages.length
    ? stages.reduce((acc, s) => acc + toNumber(s.measuredPct), 0) / stages.length
    : 0;
  const avgPlannedPct = stages.length
    ? stages.reduce((acc, s) => acc + toNumber(s.plannedPct), 0) / stages.length
    : 0;

  let scheduleProgressPct = null;
  if (project.startsAt && project.endsAtPlanned) {
    const start = new Date(project.startsAt).getTime();
    const end = new Date(project.endsAtPlanned).getTime();
    const now = Date.now();
    if (end > start) {
      scheduleProgressPct = round2(Math.min(Math.max(((now - start) / (end - start)) * 100, 0), 100));
    }
  }

  const isOverdue = Boolean(
    project.endsAtPlanned &&
      new Date(project.endsAtPlanned).getTime() < Date.now() &&
      // M6-18: obra fisicamente concluída/entregue não fica mais "em risco de atraso" — a
      // fonte lista FINAL_INSPECTION como o marco de conclusão física, seguido de
      // DELIVERED/WARRANTY/CLOSED, nenhum deles ainda "em execução".
      !['FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED', 'CANCELLED'].includes(project.status)
  );
  const scheduleDelayDays = isOverdue
    ? Math.ceil((Date.now() - new Date(project.endsAtPlanned).getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  const measurementsByStatus = measurements.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {});

  // wastagePct (M6-99, fechado 30/09/2026 2ª rodada): soma de LossRecord do tipo LOSS
  // APPROVED desta obra / baselineBudget — desperdício real de material, não estimado.
  // BUG REAL CORRIGIDO (auditoria Marco 6, ciclo 5, releitura do padrão "campo financeiro
  // somado duas vezes/não sincronizado com correção", 2026-10-06): esta soma considerava só os
  // registros LOSS, sem nunca abater os RETURN já aprovados que apontam pra eles
  // (`relatedLossRecordId`) — exatamente o saldo que `lossRecords.service.js#getMaterialBalance`
  // já calcula líquido (LOSS negativo + RETURN positivo). Material perdido e depois DEVOLVIDO
  // (RETURN) continuava contando 100% como desperdício aqui, podendo disparar o alerta de
  // "desperdício acima de 5%" (buildRisks em nayObras.service.js) mesmo quando o saldo real de
  // perda já tinha sido corrigido pra zero. Agora soma LOSS e abate RETURN, mesmo critério de
  // saldo líquido usado em getMaterialBalance.
  const lossRecords = await LossRecord.findAll({
    where: { projectId, movementType: { [Op.in]: ['LOSS', 'RETURN'] }, status: 'APPROVED' },
    transaction,
  });
  const totalLossValue = lossRecords.reduce((acc, l) => {
    const sign = l.movementType === 'RETURN' ? -1 : 1;
    return acc + sign * toNumber(l.estimatedValue);
  }, 0);
  const wastagePct = baselineBudget > 0 ? round2((Math.max(totalLossValue, 0) / baselineBudget) * 100) : null;

  // recurrenceByRootCause (M6-99, fechado 30/09/2026 2ª rodada): agrupa Nonconformity da obra
  // por motivo de perda (LossRecord.reason) e por severidade — a fonte não define uma taxonomia
  // fixa de "causa raiz" para NC, então usamos severidade (já existe, sem inventar campo novo)
  // combinada com o motivo de LossRecord quando presente.
  const nonconformities = await Nonconformity.findAll({ where: { projectId }, transaction });
  const recurrenceMap = new Map();
  for (const nc of nonconformities) {
    const key = nc.severity || 'DESCONHECIDA';
    recurrenceMap.set(key, (recurrenceMap.get(key) || 0) + 1);
  }
  // `lossRecords` agora inclui RETURN (ver fix do wastagePct acima) — recorrência de causa raiz
  // é só sobre perdas de fato (LOSS), uma devolução não é uma nova ocorrência de causa.
  for (const l of lossRecords) {
    if (l.movementType !== 'LOSS') continue;
    const key = l.reason || 'DESCONHECIDA';
    recurrenceMap.set(key, (recurrenceMap.get(key) || 0) + 1);
  }
  const recurrenceByRootCause = [...recurrenceMap.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count);

  return {
    // --- Os 9 campos pedidos pelo M6-42 ---
    baselineBudget: round2(baselineBudget),
    approvedChanges: round2(approvedChanges),
    committedCost: round2(committedCost),
    actualFinancialCost: round2(actualFinancialCost),
    consumedInventoryCost: round2(consumedInventoryCost),
    forecastToComplete: round2(forecastToComplete),
    projectedTotalCost,
    projectedMargin,
    marginPct,
    minMarginPct,
    belowMinMargin,
    updatedAt: new Date().toISOString(),

    // --- KPIs adicionais (M6-99) calculáveis só com dados desta fatia ---
    kpis: {
      physicalProgressPct: round2(avgMeasuredPct),
      plannedProgressPct: round2(avgPlannedPct),
      scheduleProgressPct,
      progressVsScheduleGapPct: scheduleProgressPct !== null ? round2(avgMeasuredPct - scheduleProgressPct) : null,
      scheduleDelayDays,
      isOverdue,
      payablePendingTotal: round2(pendingEntries.reduce((acc, e) => acc + toNumber(e.amount), 0)),
      measurementsByStatus,
      wastagePct,
      recurrenceByRootCause,
    },
  };
}

module.exports = { getProjectHealth };
