'use strict';

const { Op } = require('sequelize');
const projectHealthService = require('./projectHealth.service');
const postObraHealthService = require('./postObraHealth.service');
const { lastBusinessDays } = require('../../engines/jobs/businessDays.helper');
const {
  Project,
  ProjectStage,
  DailyReport,
  DailyWorker,
  StageMeasurement,
  Nonconformity,
} = require('../../models');

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

// GAP 3 (auditoria externa Nayara, Marco 6/NAY Obras): "ausência de aprovação de medição ou
// pagamento" como RISCO sinalizado — só leitura/diagnóstico, nenhuma execução automática.
// Dois dias-limite distintos, documentados separadamente porque representam etapas diferentes
// do fluxo de medição (`StageMeasurement.status`: DRAFT|SUBMITTED|REVIEWED|APPROVED|PAYABLE|
// REJECTED|SUPERSEDED):
//   - MEASUREMENT_PENDING_APPROVAL_DAYS: medição enviada (SUBMITTED) ou revisada (REVIEWED) mas
//     ainda não decidida (nem APPROVED nem REJECTED) há tempo demais — sinaliza que falta
//     alguém aprovar/rejeitar, a NAY NUNCA aprova nem rejeita sozinha.
//   - MEASUREMENT_PAYABLE_WITHOUT_PAYMENT_DAYS: medição já em status PAYABLE (aprovada, pronta
//     pra virar pagamento) mas sem `payableFinancialEntryId` preenchido há tempo demais —
//     sinaliza que o lançamento financeiro do pagamento ainda não foi gerado/processado.
const MEASUREMENT_PENDING_APPROVAL_DAYS = 10;
const MEASUREMENT_PAYABLE_WITHOUT_PAYMENT_DAYS = 10;

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * getStaleMeasurementRisks — lê `StageMeasurement` das etapas da obra e devolve só TEXTO de
 * risco (nenhuma aprovação, rejeição ou geração de pagamento acontece aqui). Resposta direta ao
 * requisito da Nayara de "verificar a AUSÊNCIA de execução automática de aprovação/pagamento
 * como requisito de segurança" — este helper só LÊ e DESCREVE, nunca decide.
 */
async function getStaleMeasurementRisks(projectId, transaction) {
  const stages = await ProjectStage.findAll({ where: { projectId }, transaction });
  const stageIds = stages.map((s) => s.id);
  if (stageIds.length === 0) return [];

  const measurements = await StageMeasurement.findAll({
    where: { projectStageId: { [Op.in]: stageIds }, status: { [Op.in]: ['SUBMITTED', 'REVIEWED', 'PAYABLE'] } },
    transaction,
  });

  const risks = [];
  let pendingApprovalCount = 0;
  let payableWithoutPaymentCount = 0;

  for (const measurement of measurements) {
    if (measurement.status === 'SUBMITTED' || measurement.status === 'REVIEWED') {
      const referenceDate = measurement.reviewedAt || measurement.submittedAt || measurement.createdAt;
      const age = daysSince(referenceDate);
      if (age !== null && age >= MEASUREMENT_PENDING_APPROVAL_DAYS) pendingApprovalCount += 1;
    } else if (measurement.status === 'PAYABLE' && !measurement.payableFinancialEntryId) {
      const age = daysSince(measurement.approvedAt || measurement.decidedAt || measurement.createdAt);
      if (age !== null && age >= MEASUREMENT_PAYABLE_WITHOUT_PAYMENT_DAYS) payableWithoutPaymentCount += 1;
    }
  }

  if (pendingApprovalCount > 0) {
    risks.push(
      `${pendingApprovalCount} medição(ões) aguardando aprovação/rejeição humana há ${MEASUREMENT_PENDING_APPROVAL_DAYS}+ dia(s) — a NAY apenas sinaliza, nenhuma aprovação é feita automaticamente.`
    );
  }
  if (payableWithoutPaymentCount > 0) {
    risks.push(
      `${payableWithoutPaymentCount} medição(ões) aprovada(s) (PAYABLE) sem lançamento de pagamento processado há ${MEASUREMENT_PAYABLE_WITHOUT_PAYMENT_DAYS}+ dia(s) — a NAY apenas sinaliza, nenhum pagamento é processado automaticamente.`
    );
  }
  return risks;
}

async function buildRisks(health, projectId, transaction) {
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
  risks.push(...(await getStaleMeasurementRisks(projectId, transaction)));
  return risks;
}

// GAP 1 (auditoria externa Nayara, Marco 6/NAY Obras): "detecção de ausência de diário ou
// documentos" dentro do resumo da NAY. `missingDailyReportDays` reaproveita a MESMA janela de
// dia útil de `missingDailyReportJob.js` (via `businessDays.helper.js`) — não duplica a regra de
// "o que é dia útil", só conta quantos dos últimos `windowBusinessDays` dias úteis não têm
// NENHUM `DailyReport` para a obra.
const MISSING_DAILY_REPORT_WINDOW_BUSINESS_DAYS = 10;

async function countMissingDailyReportDays(projectId, transaction, now = new Date()) {
  const businessDays = lastBusinessDays(now, MISSING_DAILY_REPORT_WINDOW_BUSINESS_DAYS);
  const reports = await DailyReport.findAll({
    where: { projectId, reportDate: { [Op.in]: businessDays } },
    transaction,
  });
  const datesWithReport = new Set(reports.map((r) => r.reportDate));
  return businessDays.filter((day) => !datesWithReport.has(day)).length;
}

/**
 * countWorkersWithoutDocuments — conta `DailyWorker` da obra sem nenhum `documentFileIds`. Query
 * direta no model (não depende do job `missingDailyReportJob.js` ter esse campo, conforme
 * instrução — se outro agente adicionar um helper equivalente lá depois, este cálculo pode
 * passar a reusá-lo, mas por ora é autônomo).
 */
async function countWorkersWithoutDocuments(projectId, transaction) {
  const reports = await DailyReport.findAll({ where: { projectId }, attributes: ['id'], transaction });
  const reportIds = reports.map((r) => r.id);
  if (reportIds.length === 0) return 0;

  const workers = await DailyWorker.findAll({
    where: { dailyReportId: { [Op.in]: reportIds } },
    transaction,
  });
  return workers.filter((w) => !Array.isArray(w.documentFileIds) || w.documentFileIds.length === 0).length;
}

// GAP 2 (auditoria externa Nayara, Marco 6/NAY Obras): "sugestão de análise visual com
// confirmação humana". Isto NÃO é visão computacional — não existe análise de imagem real no
// sistema. É uma heurística simples baseada em METADADOS que já existem (data do RDO/NC mais
// recente com evidência anexada via `evidenceFileIds`/`beforeEvidenceFileIds`/
// `afterEvidenceFileIds`) virando um texto estruturado de sugestão. A confirmação (se de fato
// vale a pena uma nova inspeção visual) é sempre humana — a NAY só aponta "há quanto tempo não
// chega uma foto nova", nunca decide que algo está certo ou errado na imagem.
const VISUAL_ANALYSIS_STALE_DAYS = 15;

async function buildVisualAnalysisSuggestions(projectId, transaction) {
  const suggestions = [];

  const lastReportWithEvidence = await DailyReport.findOne({
    where: { projectId, evidenceFileIds: { [Op.ne]: [] } },
    order: [['reportDate', 'DESC']],
    transaction,
  });
  if (lastReportWithEvidence) {
    const age = daysSince(lastReportWithEvidence.reportDate);
    if (age !== null && age >= VISUAL_ANALYSIS_STALE_DAYS) {
      suggestions.push({
        type: 'DAILY_REPORT_PHOTO_STALE',
        message: `A última foto anexada a um RDO tem ${age} dia(s) (RDO de ${lastReportWithEvidence.reportDate}). Considere uma nova inspeção visual — sugestão baseada em metadados, pendente de confirmação humana.`,
        referenceEntity: 'construction.daily_reports',
        referenceId: lastReportWithEvidence.id,
        ageDays: age,
      });
    }
  } else {
    suggestions.push({
      type: 'NO_DAILY_REPORT_PHOTO',
      message: 'Nenhum RDO desta obra tem foto anexada (evidenceFileIds vazio). Considere registrar evidência visual no próximo diário — sugestão baseada em metadados, pendente de confirmação humana.',
      referenceEntity: 'construction.daily_reports',
      referenceId: null,
      ageDays: null,
    });
  }

  const openNonconformities = await Nonconformity.findAll({ where: { projectId, status: 'OPEN' }, transaction });
  const ncsWithoutAfterEvidence = openNonconformities.filter(
    (nc) => !Array.isArray(nc.afterEvidenceFileIds) || nc.afterEvidenceFileIds.length === 0
  );
  if (ncsWithoutAfterEvidence.length > 0) {
    suggestions.push({
      type: 'NONCONFORMITY_WITHOUT_AFTER_EVIDENCE',
      message: `${ncsWithoutAfterEvidence.length} não conformidade(s) aberta(s) sem evidência "depois" anexada. Considere nova inspeção visual para confirmar correção — sugestão baseada em metadados, pendente de confirmação humana.`,
      referenceEntity: 'construction.nonconformities',
      referenceId: null,
      ageDays: null,
    });
  }

  return suggestions;
}

/**
 * summarizeProject — resumo determinístico do estado de uma obra em andamento (progresso,
 * custos, qualidade), reusando o read model de saúde já existente. Nunca decide nada, só
 * organiza o que já é fato no banco.
 */
async function summarizeProject(projectId, transaction) {
  const health = await projectHealthService.getProjectHealth(projectId, transaction);

  const [missingDailyReportDays, workersWithoutDocuments, visualAnalysisSuggestions, risks] = await Promise.all([
    countMissingDailyReportDays(projectId, transaction),
    countWorkersWithoutDocuments(projectId, transaction),
    buildVisualAnalysisSuggestions(projectId, transaction),
    buildRisks(health, projectId, transaction),
  ]);

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
      // GAP 1 (auditoria externa Nayara): ausência de diário/documentos, dentro da mesma janela
      // de dia útil do job de detecção de RDO ausente (ver `businessDays.helper.js`).
      missingDailyReportDays,
      workersWithoutDocuments,
    },
    // GAP 2 (auditoria externa Nayara): sugestão estruturada de análise visual baseada em
    // metadados (nunca visão computacional real) — sempre pendente de confirmação humana.
    visualAnalysisSuggestions,
    risks,
    // M6-27: NAY é assistiva — nenhum efeito automático, isto é só apresentação de dado real.
    //
    // GAP 3 (auditoria externa Nayara, Marco 6/NAY Obras): `buildRisks()` agora também sinaliza
    // medição pendente de aprovação/rejeição e medição aprovada sem pagamento processado (ver
    // `getStaleMeasurementRisks`), mas isso é SÓ TEXTO DE RISCO na lista `risks` acima.
    // `decisionsMade` continua, e sempre vai continuar, hardcoded como array vazio: a NAY NUNCA
    // aprova/rejeita medição, NUNCA gera ou processa pagamento, e NUNCA atribui culpa
    // automaticamente. Isso é uma trava de segurança financeira deliberada (M6-27, "NAY sugere,
    // nunca decide"), não uma lacuna técnica pendente — a Nayara pediu para confirmar a AUSÊNCIA
    // dessas execuções automáticas como requisito de segurança, e este comentário + o teste
    // `nayObras.service.test.js` são essa comprovação.
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
