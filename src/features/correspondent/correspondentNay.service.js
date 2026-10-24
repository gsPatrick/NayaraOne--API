'use strict';

const { FinancingCase, CaseRequirement, Simulation } = require('../../models');
const AppError = require('../../utils/AppError');

/**
 * NAY Correspondente — componente nomeado da NAY para o módulo de Correspondente Bancário
 * (Marco 8 Fase 10).
 *
 * Contrato bruto (Caderno Técnico, bloco CORRESPONDENTE + addendum):
 *   "NAY checa pendências de documentos/requirements e sinaliza caso parado. Compara simulações
 *    de forma objetiva (determinística — isso NÃO exige LLM). Nunca decide crédito, promete
 *    aprovação/taxa/prazo, nem envia documento sem passar pelo workflow."
 *
 * MESMA DECISÃO DE ENGENHARIA de nayObras.service.js e inventoryNay.service.js (templates deste
 * arquivo): o projeto não tem nenhuma integração de LLM/IA generativa contratada. A NAY
 * Correspondente é RULE-BASED/determinística sobre dados já persistidos — cada função aqui é
 * SOMENTE LEITURA.
 *
 * Fronteira "sinaliza, nunca decide", garantida por construção (não só convenção):
 *   - Nenhuma função deste arquivo importa ou chama FinancingCase.update/save, nem qualquer
 *     service que mude `status` (financingCases.service, webhooks.service, submissions.service).
 *     O ÚNICO jeito de um case avançar de status é via webhook do provider (Fase 6) ou ação
 *     humana explícita (submissão, Fase 5) — nunca a partir da NAY.
 *   - Nenhuma função chama `resolveFinancingProviderAdapter`/`.submitCase()`/`.simulate()` —
 *     NAY nunca fala com o provider diretamente, só lê simulações/submissões já registradas.
 *   - Nenhuma string de resposta contém valor de taxa/prazo/parcela como PROMESSA — os números
 *     retornados são sempre de simulações JÁ REALIZADAS (Fase 3), nunca uma estimativa nova
 *     calculada pela NAY. `recommendedSimulationId` é um RÓTULO objetivo (menor parcela), nunca
 *     "você vai conseguir X".
 */

const COMPONENT_NAME = 'NAY Correspondente';
const STALLED_THRESHOLD_DAYS_DEFAULT = 7;
const PENDING_STATUSES = ['DRAFT', 'DOCUMENTS_PENDING', 'READY_TO_SUBMIT', 'SUBMITTED', 'UNDER_ANALYSIS', 'PENDING_CUSTOMER', 'PENDING_PROPERTY'];

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}

/**
 * checkStalledCases — lê financing_cases em status não-terminal cuja última atualização
 * (updated_at) passou do limiar configurado, e monta o motivo específico olhando o checklist de
 * requirements. SOMENTE LEITURA: nenhum status é alterado, nenhuma sugestão é persistida.
 */
async function checkStalledCases(groupId, companyId, options, transaction) {
  const thresholdDays = Number.isInteger(options?.thresholdDays) && options.thresholdDays > 0
    ? options.thresholdDays
    : STALLED_THRESHOLD_DAYS_DEFAULT;

  const cases = await FinancingCase.findAll({
    where: { groupId, companyId, status: PENDING_STATUSES },
    include: [{ model: CaseRequirement, as: 'requirements', required: false }],
    order: [['updated_at', 'ASC']],
    transaction,
  });

  const stalled = [];
  for (const financingCase of cases) {
    const idleDays = daysSince(financingCase.updatedAt ?? financingCase.updated_at);
    if (idleDays === null || idleDays < thresholdDays) continue;

    const requirements = financingCase.requirements || [];
    const pendingRequirements = requirements.filter((r) => r.required && r.status === 'PENDING');

    let reason;
    if (pendingRequirements.length > 0) {
      reason = `${pendingRequirements.length} documento(s) obrigatório(s) pendente(s): ${pendingRequirements.map((r) => r.documentType).join(', ')}.`;
    } else if (financingCase.status === 'SUBMITTED' || financingCase.status === 'UNDER_ANALYSIS') {
      reason = 'Aguardando resposta do provider — nenhuma atualização de status recente.';
    } else if (financingCase.status === 'PENDING_CUSTOMER') {
      reason = 'Aguardando ação do cliente (dado sinalizado pelo provider).';
    } else if (financingCase.status === 'PENDING_PROPERTY') {
      reason = 'Aguardando resolução de pendência do imóvel (dado sinalizado pelo provider).';
    } else {
      reason = 'Sem atividade recente neste status.';
    }

    stalled.push({
      financingCaseId: financingCase.id,
      status: financingCase.status,
      idleDays,
      reason,
      pendingRequirementTypes: pendingRequirements.map((r) => r.documentType),
    });
  }

  return {
    component: COMPONENT_NAME,
    method: 'RULE_BASED',
    thresholdDays,
    decisionsMade: [],
    disclaimer: 'Sinalização da NAY: indica casos sem atividade recente para apoiar o acompanhamento humano. Não decide, não aprova e não altera nenhum caso.',
    cases: stalled,
  };
}

/**
 * compareSimulations — lê as simulações já realizadas (Fase 3) de um case e as ordena de forma
 * objetiva (menor parcela mensal primeiro). SOMENTE LEITURA: não cria nenhuma simulação nova,
 * não chama nenhum adapter/provider.
 */
async function compareSimulations(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }

  const simulations = await Simulation.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });

  const ranked = [...simulations].sort((a, b) => Number(a.monthlyPayment) - Number(b.monthlyPayment));
  const recommendedSimulationId = ranked.length > 0 ? ranked[0].id : null;

  return {
    component: COMPONENT_NAME,
    method: 'RULE_BASED',
    criterion: 'LOWEST_MONTHLY_PAYMENT',
    decisionsMade: [],
    disclaimer: 'Comparação objetiva de simulações já realizadas. Não é uma promessa de aprovação, taxa ou prazo — apenas ordena dados já existentes pelo menor valor de parcela.',
    financingCaseId,
    recommendedSimulationId,
    simulations: simulations.map((s) => ({
      id: s.id,
      providerCode: s.providerCode,
      amount: Number(s.amount),
      termMonths: s.termMonths,
      monthlyPayment: Number(s.monthlyPayment),
      rate: Number(s.rate),
      createdAt: s.createdAt,
      recommended: s.id === recommendedSimulationId,
    })),
  };
}

module.exports = { checkStalledCases, compareSimulations, STALLED_THRESHOLD_DAYS_DEFAULT };
