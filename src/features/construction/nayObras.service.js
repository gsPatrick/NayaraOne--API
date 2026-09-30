'use strict';

const projectHealthService = require('./projectHealth.service');
const postObraHealthService = require('./postObraHealth.service');

/**
 * NAY Obras (M6-101/M6-27/M6-90) — componente nomeado da NAY dedicado ao módulo de Obras,
 * exigido explicitamente pela fonte ("IA NAY — 4. Componentes": "NAY Obras — progresso,
 * custos, diário, qualidade e pós-obra").
 *
 * DECISÃO DE ENGENHARIA (mesma situação já documentada para M5-30/M4-22/M3-22): este projeto
 * não tem NENHUMA integração de LLM/IA generativa ainda — decisão de negócio/custo comunicada
 * à cliente, fora do controle de código. Implementar aqui um componente que FINGE ser IA
 * (texto solto tentando parecer natural) seria pior que não ter nada — geraria uma falsa
 * expectativa de inteligência que não existe.
 *
 * O que ESTE arquivo entrega, honestamente: "NAY Obras" como um componente REAL e nomeado
 * (`summarizeProject`), que resume o estado da obra — mas com uma implementação
 * RULE-BASED/determinística sobre os read models já existentes (`projectHealth.service.js`/
 * `postObraHealth.service.js`), nunca inferência probabilística. Isso satisfaz a exigência de
 * "existe um componente chamado NAY Obras que resume progresso/custos/diário/qualidade/
 * pós-obra" (M6-101) sem inventar uma capacidade de IA que o projeto não tem — a regra
 * "NAY sugere, nunca decide" (M6-27) continua valendo: nada aqui aprova medição, pagamento,
 * culpa ou desconto, é só apresentação de dado que já existe.
 */

function buildRisks(health) {
  const risks = [];
  if (health.kpis.isOverdue) {
    risks.push(`Obra atrasada em ${health.kpis.scheduleDelayDays} dia(s) em relação ao prazo planejado.`);
  }
  if (health.projectedMargin < 0) {
    risks.push(`Margem projetada negativa (${health.projectedMargin}) — custo total projetado excede o orçamento + change orders aprovados.`);
  }
  if (health.kpis.wastagePct !== null && health.kpis.wastagePct > 5) {
    risks.push(`Desperdício de material acima de 5% do orçamento (${health.kpis.wastagePct}%).`);
  }
  if (health.kpis.payablePendingTotal > 0) {
    risks.push(`Existe valor pendente de pagamento: ${health.kpis.payablePendingTotal}.`);
  }
  return risks;
}

/**
 * summarizeProject — resumo determinístico do estado de uma obra em andamento (progresso,
 * custos, qualidade), reusando o read model de saúde já existente. Nunca decide nada, só
 * organiza o que já é fato no banco.
 */
async function summarizeProject(projectId, transaction) {
  const health = await projectHealthService.getProjectHealth(projectId, transaction);

  return {
    component: 'NAY Obras',
    generatedAt: new Date().toISOString(),
    summary: {
      physicalProgressPct: health.kpis.physicalProgressPct,
      plannedProgressPct: health.kpis.plannedProgressPct,
      scheduleDelayDays: health.kpis.scheduleDelayDays,
      baselineBudget: health.baselineBudget,
      projectedTotalCost: health.projectedTotalCost,
      projectedMargin: health.projectedMargin,
      measurementsByStatus: health.kpis.measurementsByStatus,
      wastagePct: health.kpis.wastagePct,
      recurrenceByRootCause: health.kpis.recurrenceByRootCause,
    },
    risks: buildRisks(health),
    // M6-27: NAY é assistiva — nenhum efeito automático, isto é só apresentação de dado real.
    decisionsMade: [],
  };
}

/**
 * summarizePostObra — resumo determinístico do estado de pós-obra/garantia de uma obra já
 * entregue, reusando o read model separado de pós-obra (M6-100).
 */
async function summarizePostObra(projectId, transaction) {
  const postObra = await postObraHealthService.getPostObraHealth(projectId, transaction);

  const risks = [];
  if (postObra.casesByEscalationLevel.OVERDUE > 0) {
    risks.push(`${postObra.casesByEscalationLevel.OVERDUE} caso(s) de garantia com SLA vencido (OVERDUE).`);
  }
  if (postObra.casesByEscalationLevel.CRITICAL > 0) {
    risks.push(`${postObra.casesByEscalationLevel.CRITICAL} caso(s) de garantia com SLA crítico.`);
  }

  return {
    component: 'NAY Obras',
    generatedAt: new Date().toISOString(),
    summary: postObra,
    risks,
    decisionsMade: [],
  };
}

module.exports = { summarizeProject, summarizePostObra };
