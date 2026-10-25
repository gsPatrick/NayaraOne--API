'use strict';

const { FinancingCase, CaseRequirement, Simulation, CaseApplicant, ProviderSubmission, FinancingProposal, CommissionEntitlement } = require('../../models');
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

const STATUS_LABEL = {
  DRAFT: 'Rascunho',
  DOCUMENTS_PENDING: 'Documentos pendentes',
  READY_TO_SUBMIT: 'Pronto para enviar',
  SUBMITTED: 'Enviado ao provider',
  UNDER_ANALYSIS: 'Em análise',
  PENDING_CUSTOMER: 'Aguardando o cliente',
  PENDING_PROPERTY: 'Aguardando documentação do imóvel',
  APPROVED: 'Aprovado pelo banco',
  REJECTED: 'Recusado pelo banco',
  CONTRACTING: 'Em contratação',
  COMPLETED: 'Concluído',
  CANCELED: 'Cancelado',
};
const DOCUMENT_LABEL = {
  RG_CPF: 'RG/CPF',
  COMPROVANTE_RENDA: 'comprovante de renda',
  COMPROVANTE_RESIDENCIA: 'comprovante de residência',
  MATRICULA_IMOVEL: 'matrícula do imóvel',
  CERTIDAO_ESTADO_CIVIL: 'certidão de estado civil',
  IPTU: 'IPTU',
  OUTRO: 'outro documento',
};
const docLabel = (type) => DOCUMENT_LABEL[type] || type;
const SUBMISSION_LABEL = { PENDING: 'pendente de envio', SUBMITTED: 'enviado', UNKNOWN: 'com resultado desconhecido (consultar antes de reenviar)', FAILED: 'com falha', CANCELED: 'cancelado' };

function reais(value) {
  const [inteiro, centavos] = Number(value).toFixed(2).split('.');
  return `${inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${centavos}`;
}

/**
 * summarizeCase — "NAY resume e sugere" (Caderno). Síntese determinística do caso, montada só com
 * dados já gravados (checklist, simulações, envio, proposta que o BANCO informou, comissão). Cada
 * linha cita a origem do dado ("grounding"). SOMENTE LEITURA: não altera nada, não chama provider,
 * não avalia crédito e não projeta taxa, prazo ou aprovação — a proposta citada é a que o banco
 * já devolveu e foi registrada por uma pessoa ou pelo webhook.
 */
async function summarizeCase(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({
    where: { id: financingCaseId, groupId, companyId },
    include: [
      { model: CaseRequirement, as: 'requirements', required: false },
      { model: CaseApplicant, as: 'applicants', required: false },
    ],
    transaction,
  });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }

  const [simulations, submissions, proposal, commissions] = await Promise.all([
    Simulation.findAll({ where: { financingCaseId, groupId, companyId }, order: [['created_at', 'DESC']], transaction }),
    ProviderSubmission.findAll({ where: { financingCaseId, groupId, companyId }, order: [['created_at', 'DESC']], transaction }),
    FinancingProposal.findOne({ where: { financingCaseId, groupId, companyId, status: 'ACTIVE' }, transaction }),
    CommissionEntitlement.findAll({ where: { financingCaseId, groupId, companyId }, transaction }),
  ]);

  const requirements = financingCase.requirements || [];
  const required = requirements.filter((r) => r.required);
  const validated = required.filter((r) => r.status === 'VALIDATED');
  const pending = required.filter((r) => r.status !== 'VALIDATED');
  const lowest = simulations.length ? [...simulations].sort((a, b) => Number(a.monthlyPayment) - Number(b.monthlyPayment))[0] : null;
  const lastSubmission = submissions[0] || null;
  const activeCommissions = commissions.filter((c) => c.status !== 'ADJUSTED');

  const lines = [];
  lines.push({ topic: 'Situação', source: 'financing_cases.status', text: `O caso está em "${STATUS_LABEL[financingCase.status] || financingCase.status}", com ${(financingCase.applicants || []).length} proponente(s), provider "${financingCase.providerCode}".` });
  lines.push({
    topic: 'Documentos',
    source: 'case_requirements',
    text: required.length === 0
      ? 'O checklist ainda não tem documento obrigatório cadastrado.'
      : `${validated.length} de ${required.length} documento(s) obrigatório(s) validado(s)${pending.length ? `; falta(m): ${pending.map((r) => docLabel(r.documentType)).join(', ')}` : ''}.`,
  });
  lines.push({
    topic: 'Simulações',
    source: 'simulations',
    text: simulations.length === 0
      ? 'Nenhuma simulação registrada.'
      : `${simulations.length} simulação(ões) registrada(s); a de menor parcela é de R$ ${reais(lowest.monthlyPayment)} em ${lowest.termMonths} meses (ordenação objetiva, não é recomendação de crédito).`,
  });
  lines.push({
    topic: 'Envio',
    source: 'provider_submissions',
    text: lastSubmission ? `O último envio está ${SUBMISSION_LABEL[lastSubmission.status] || lastSubmission.status}.` : 'Ainda não houve envio ao provider.',
  });
  lines.push({
    topic: 'Proposta do banco',
    source: 'proposals',
    text: proposal
      ? `O banco informou proposta vigente de R$ ${reais(proposal.approvedAmount)} em ${proposal.termMonths} meses (registrada em ${new Date(proposal.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}).`
      : 'O banco ainda não informou proposta.',
  });
  lines.push({
    topic: 'Comissão',
    source: 'commission_entitlements',
    text: activeCommissions.length ? `${activeCommissions.length} direito(s) de comissão registrado(s), total de R$ ${reais(activeCommissions.reduce((sum, c) => sum + Number(c.amount), 0))}.` : 'Nenhuma comissão registrada.',
  });
  if (financingCase.possibleDuplicateOfCaseId && financingCase.duplicateReviewStatus === 'PENDING') {
    lines.push({ topic: 'Duplicidade', source: 'financing_cases.possible_duplicate_of_case_id', text: 'O caso foi sinalizado como possível duplicata e aguarda revisão.' });
  }

  const suggestions = [];
  if (!['COMPLETED', 'CANCELED', 'REJECTED'].includes(financingCase.status)) {
    if (pending.length) suggestions.push(`Providenciar e validar o(s) documento(s) pendente(s): ${pending.map((r) => docLabel(r.documentType)).join(', ')}.`);
    if (!pending.length && required.length && ['DRAFT', 'DOCUMENTS_PENDING', 'READY_TO_SUBMIT'].includes(financingCase.status) && !lastSubmission) suggestions.push('Checklist completo: uma pessoa pode registrar o consentimento do cliente e enviar o caso.');
    if (lastSubmission && lastSubmission.status === 'UNKNOWN') suggestions.push('Consultar o status do envio antes de qualquer reenvio.');
    if (financingCase.status === 'PENDING_CUSTOMER') suggestions.push('Contatar o cliente para entregar o que o banco pediu.');
    if (financingCase.status === 'PENDING_PROPERTY') suggestions.push('Reunir a documentação do imóvel pedida pelo banco.');
    if (simulations.length === 0 && financingCase.providerCode !== 'manual') suggestions.push('Registrar ao menos uma simulação para comparar parcelas.');
  }

  return {
    component: COMPONENT_NAME,
    method: 'RULE_BASED',
    decisionsMade: [],
    disclaimer: 'Resumo montado só com dados já registrados no caso. A NAY não aprova crédito, não promete taxa nem prazo e não envia documento: qualquer ação continua com uma pessoa.',
    financingCaseId,
    status: financingCase.status,
    lines,
    suggestions,
    generatedAt: new Date(),
  };
}

module.exports = { checkStalledCases, compareSimulations, summarizeCase, STALLED_THRESHOLD_DAYS_DEFAULT };
