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
 * computeMarginProjection — TAREFA (auditoria externa Nayara, item A9/caderno técnico p.161
 * seção 5: "Margem abaixo da regra gera alerta ou bloqueio, conforme configurado"). Extrai a
 * MESMA fórmula de projectedMargin/marginPct/belowMinMargin já usada em getProjectHealth (ver
 * comentários detalhados logo abaixo, linhas ~138-206 originais) para ser reaproveitada nos
 * pontos de decisão real (budgets.service.js#approveBudget, changeOrders.service.js#
 * decideChangeOrder) — NUNCA duplica a fórmula.
 *
 * `extraApprovedChanges` permite projetar o efeito de uma aprovação AINDA NÃO commitada: ao
 * decidir um Change Order (ainda PENDING_APPROVAL, portanto fora de getApprovedChangeOrdersTotal
 * até a transação commitar), passamos o `budgetImpact` dele aqui para calcular a margem COMO
 * FICARIA se esta aprovação específica fosse confirmada — sem gravar nada ainda. Em
 * approveBudget, nenhum delta é necessário: committedCost já vem da soma das BudgetLine
 * existentes (independente do status do Budget agregado), e approvedChanges já reflete os
 * Change Orders já aprovados anteriormente.
 */
async function computeMarginProjection(projectId, transaction, { extraApprovedChanges = 0 } = {}) {
  const project = await getProject(projectId, transaction);

  const [budgetLines, settledEntries] = await Promise.all([
    BudgetLine.findAll({ where: { projectId }, transaction }),
    FinancialEntry.findAll({
      where: { constructionProjectId: projectId, nature: 'PAYABLE', status: { [Op.in]: ['SETTLED', 'PARTIALLY_SETTLED'] } },
      transaction,
    }),
  ]);

  const committedCost = budgetLines.reduce((acc, line) => acc + toNumber(line.plannedAmount), 0);
  const approvedChangesBase = await getApprovedChangeOrdersTotal(projectId, transaction);
  const approvedChanges = approvedChangesBase + toNumber(extraApprovedChanges);

  const settledIds = settledEntries.map((e) => e.id);
  const partialSettlements = settledIds.length
    ? await FinancialEntry.findAll({
        where: { parentEntryId: { [Op.in]: settledIds }, status: 'SETTLED' },
        transaction,
      })
    : [];
  const actualFinancialCost = settledEntries.reduce((acc, entry) => {
    if (entry.status === 'SETTLED') return acc + toNumber(entry.amount);
    return acc;
  }, 0) + partialSettlements.reduce((acc, s) => acc + toNumber(s.amount), 0);

  const consumedInventoryCost = await getConsumedInventoryCost(projectId, transaction);

  const realizedCost = actualFinancialCost + consumedInventoryCost;
  const marginBudgetBase = committedCost + approvedChanges;

  // BUG REAL CORRIGIDO (auditoria externa Nayara/ChatGPT, reteste 10/10/2026 — F2): a fórmula
  // anterior calculava `forecastToComplete = max(B - R, 0)` — ou seja, SEMPRE assumia que o
  // restante do orçamento inteiro ainda seria gasto até o fim, nunca menos. Isso faz
  // `projectedTotalCost` nunca ficar abaixo de B: se R < B, projectedTotalCost = R + (B-R) = B
  // (margem sempre 0); se R >= B, projectedTotalCost = R (margem sempre <= 0). Prova algébrica:
  // a margem projetada NUNCA podia ser positiva, estruturalmente — mesmo uma obra terminando
  // genuinamente abaixo do orçamento nunca mostraria lucro/economia projetada, só "zero" ou
  // "prejuízo". O Caderno Técnico (seção 7, "Read model de custo") exige os CAMPOS
  // (forecastToComplete/projectedTotalCost/projectedMargin) mas não fecha a fórmula — a escolha
  // de "sempre gastar o resto do orçamento" era conservadora demais a ponto de quebrar o
  // propósito do KPI (nunca sinaliza economia real).
  //
  // Fix: Estimate At Completion (EAC) por desempenho de custo — método padrão de controle de
  // obra (EVM/CPI), só ativado quando já existe progresso físico medido (measuredPct > 0 em
  // pelo menos uma etapa). Com progresso real, o restante do trabalho é projetado pela MESMA
  // taxa de custo-por-%-concluído já observada: EAC = realizedCost / (progresso físico / 100).
  // Isso permite projectedTotalCost < B (margem positiva) quando a obra está gastando menos por
  // % concluído do que o orçado, e > B (margem mais negativa) quando está gastando mais — nos
  // dois sentidos, não só pra baixo. Sem NENHUM progresso físico medido ainda (obra recém-criada,
  // sem nenhuma StageMeasurement aprovada), não há dado real pra projetar desempenho — mantém o
  // comportamento conservador anterior (assume gastar o que resta do orçamento) em vez de
  // inventar uma estimativa sem base.
  const stagesForProgress = await ProjectStage.findAll({ where: { projectId }, transaction });
  const physicalProgressPct = stagesForProgress.length
    ? stagesForProgress.reduce((acc, s) => acc + toNumber(s.measuredPct), 0) / stagesForProgress.length
    : 0;

  let forecastToComplete;
  let projectedTotalCost;
  if (physicalProgressPct > 0) {
    const estimateAtCompletion = realizedCost / (physicalProgressPct / 100);
    forecastToComplete = Math.max(estimateAtCompletion - realizedCost, 0);
    projectedTotalCost = round2(estimateAtCompletion);
  } else {
    forecastToComplete = Math.max(marginBudgetBase - realizedCost, 0);
    projectedTotalCost = round2(realizedCost + forecastToComplete);
  }

  const projectedMargin = round2(marginBudgetBase - projectedTotalCost);
  const marginPct = marginBudgetBase > 0 ? round2((projectedMargin / marginBudgetBase) * 100) : null;

  const marginEvaluation = await evaluateRule(
    MARGIN_RULE_CODE,
    { marginRuleActive: true },
    { groupId: project.groupId, companyId: project.companyId },
    { transaction }
  );
  const minMarginPct = marginEvaluation.decision === 'APPLY' ? Number(marginEvaluation.action.minMarginPct) : null;
  const enforcementMode = marginEvaluation.decision === 'APPLY'
    ? (marginEvaluation.action.enforcementMode || 'ALERT')
    : 'ALERT';
  const belowMinMargin = marginPct !== null && minMarginPct !== null ? marginPct < minMarginPct : null;

  // BUG REAL CORRIGIDO (auditoria externa Nayara/ChatGPT, reteste 10/10/2026 — F5): economyPct/
  // commissionPct eram validados, salvos e versionados (rule_version_id preservado — ver
  // marginRules.service.js) mas NUNCA entravam em nenhum cálculo — ficavam "mortos" após salvos.
  // O Caderno Técnico (seção 2 "Invariantes") exige que "margem mínima, economia e comissão
  // vêm do Motor de Regras e guardam rule_version_id" — a parte de guardar a versão já estava
  // correta; faltava a aplicação operacional. Decisão de engenharia (o caderno não fecha a
  // fórmula exata, mesma situação documentada pra minMarginPct): economyPct/commissionPct são
  // parâmetros CONFIGURÁVEIS por empresa, então sua aplicação só pode ser calculada quando a
  // margem projetada é POSITIVA (há economia real de fato, não hipotética) — nunca gera
  // pagamento/lançamento financeiro automático (consistente com "IA não atribui culpa nem
  // executa desconto automaticamente", seção 10, mesmo espírito aplicado aqui por segurança:
  // só exposição informativa pro humano decidir). economyAmount = a economia projetada em R$
  // (projectedMargin quando positivo, 0 caso contrário — nunca negativo, "economia" não é
  // "prejuízo"). commissionAmount = economyAmount * commissionPct / 100, só quando a regra tem
  // commissionPct configurado; null quando não há regra ativa ou commissionPct não configurado
  // (nunca inventa um percentual).
  const economyPct = marginEvaluation.decision === 'APPLY' && marginEvaluation.action.economyPct !== undefined && marginEvaluation.action.economyPct !== null
    ? Number(marginEvaluation.action.economyPct)
    : null;
  const commissionPct = marginEvaluation.decision === 'APPLY' && marginEvaluation.action.commissionPct !== undefined && marginEvaluation.action.commissionPct !== null
    ? Number(marginEvaluation.action.commissionPct)
    : null;
  const economyAmount = round2(Math.max(projectedMargin, 0));
  const commissionAmount = commissionPct !== null ? round2((economyAmount * commissionPct) / 100) : null;

  return {
    project,
    committedCost,
    approvedChanges,
    actualFinancialCost,
    consumedInventoryCost,
    realizedCost,
    forecastToComplete,
    projectedTotalCost,
    marginBudgetBase,
    projectedMargin,
    marginPct,
    minMarginPct,
    belowMinMargin,
    enforcementMode,
    ruleVersionId: marginEvaluation.decision === 'APPLY' ? marginEvaluation.ruleVersionId : null,
    economyPct,
    commissionPct,
    economyAmount,
    commissionAmount,
  };
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
 *  6. forecastToComplete     — max(committedCost + approvedChanges - (actualFinancialCost +
 *                               consumedInventoryCost), 0). GAP CORRIGIDO (item 1, auditoria
 *                               pós-Marco 6): custo realizado = Financeiro + Estoque já consumido
 *                               ("Custo realizado vem de Financeiro/Estoque", seção 5 do contrato).
 *  7. projectedTotalCost     — (actualFinancialCost + consumedInventoryCost) + forecastToComplete.
 *  8. projectedMargin        — (committedCost + approvedChanges) - projectedTotalCost.
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
  // Fórmula de margem (committedCost/approvedChanges/forecastToComplete/projectedMargin/
  // marginPct/minMarginPct/belowMinMargin/enforcementMode) extraída pra computeMarginProjection()
  // acima — reaproveitada tal e qual aqui e nos pontos de bloqueio (budgets.service.js/
  // changeOrders.service.js), NUNCA duplicada (TAREFA auditoria externa Nayara, item A9).
  const {
    project,
    committedCost,
    approvedChanges,
    actualFinancialCost,
    consumedInventoryCost,
    forecastToComplete,
    projectedTotalCost,
    projectedMargin,
    marginPct,
    minMarginPct,
    belowMinMargin,
    ruleVersionId,
    economyPct,
    commissionPct,
    economyAmount,
    commissionAmount,
  } = await computeMarginProjection(projectId, transaction);

  const baselineBudget = project.budgetAmount !== null && project.budgetAmount !== undefined
    ? toNumber(project.budgetAmount)
    : committedCost;

  const [stages, pendingEntries] = await Promise.all([
    ProjectStage.findAll({ where: { projectId }, transaction }),
    FinancialEntry.findAll({
      where: { constructionProjectId: projectId, nature: 'PAYABLE', status: 'PENDING' },
      transaction,
    }),
  ]);

  const stageIds = stages.map((s) => s.id);
  const measurements = stageIds.length
    ? await StageMeasurement.findAll({ where: { projectStageId: { [Op.in]: stageIds } }, transaction })
    : [];

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
    ruleVersionId,
    economyPct,
    commissionPct,
    economyAmount,
    commissionAmount,
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

module.exports = { getProjectHealth, computeMarginProjection };
