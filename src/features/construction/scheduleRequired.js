'use strict';

const AppError = require('../../utils/AppError');

/**
 * Prazos obrigatórios de Obras (segunda leva de 16/11/2026, DI-BI2-3).
 *
 * - Etapa: o Caderno de Obras lista entre as invariantes obrigatórias "Etapas possuem ... prazo"
 *   (M6:16), e o indicador de atrasos do M9 (obraDelays.js) trata etapa sem prazo como dado
 *   incompleto, inclusive PENDING. Por isso o prazo (endsAt) passa a ser exigido já na criação e
 *   não pode ser retirado na edição. Custo, código e responsável continuam exigidos só no início
 *   da etapa (decisão da rodada 46 em projectStages.service.js), que segue valendo para eles.
 * - Obra: a previsão de término (endsAtPlanned) é exigida na passagem READY -> ACTIVE
 *   (projects.service.js#transitionProject; M6:11, M9:793). Depois disso ela não pode ser apagada
 *   enquanto a obra estiver em execução ou depois dela. O mesmo vale para os outros campos do gate
 *   (orçamento, início e responsável; DI-BI2-9). PLANNED, BUDGETED e READY continuam sendo
 *   preenchidos aos poucos; CANCELLED fica fora.
 */

// Obra que já passou por READY -> ACTIVE (a cadeia do Anexo I depois da execução começar): os campos do gate travam.
const PLANNED_END_LOCKED_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED']);

/** Vazio: null, undefined, texto em branco. Valor inválido não é "vazio" (o validador do campo recusa). */
function isBlankDate(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function stageEndRequired() {
  return AppError.unprocessable(
    'Informe o prazo da etapa (data de término prevista). Toda etapa tem prazo.',
    'PROJECT_STAGE_END_DATE_REQUIRED',
    { field: 'endsAt' }
  );
}

/** Criação de etapa: sem prazo, 422. */
function assertStageEndOnCreate(endsAt) {
  if (isBlankDate(endsAt)) throw stageEndRequired();
}

/** Edição de etapa: o prazo pode ser trocado, nunca retirado (campo ausente no payload = não mexe). */
function assertStageEndKept(endsAt) {
  if (endsAt !== undefined && isBlankDate(endsAt)) throw stageEndRequired();
}

// Campos que o gate READY -> ACTIVE exige (projects.service.js#transitionProject) e o código de cada um quando
// alguém tenta apagá-lo com a obra em execução ou depois dela (DI-BI2-9). Trocar o valor continua permitido.
const EXECUTION_REQUIRED_FIELDS = Object.freeze([
  { field: 'budgetAmount', code: 'PROJECT_BUDGET_AMOUNT_REQUIRED', what: 'o orçamento pode ser alterado, mas não apagado' },
  { field: 'startsAt', code: 'PROJECT_START_DATE_REQUIRED', what: 'a data de início pode ser alterada, mas não apagada' },
  { field: 'endsAtPlanned', code: 'PROJECT_PLANNED_END_REQUIRED', what: 'a previsão de término pode ser alterada, mas não apagada' },
  { field: 'responsibleUserId', code: 'PROJECT_RESPONSIBLE_REQUIRED', what: 'o responsável pode ser trocado, mas não retirado' },
]);

/**
 * Edição de obra: depois de READY -> ACTIVE nenhum campo do gate pode ser apagado (campo ausente no payload = não
 * mexe). Chamado antes de qualquer outra checagem do PATCH, para o erro ser o específico do campo.
 */
function assertExecutionFieldsKept(project, payload) {
  if (!PLANNED_END_LOCKED_STATUSES.includes(project.status)) return;
  for (const { field, code, what } of EXECUTION_REQUIRED_FIELDS) {
    const value = payload[field];
    if (value === undefined || !isBlankDate(value)) continue;
    throw AppError.unprocessable(`A obra já está em execução: ${what}.`, code, { field, status: project.status });
  }
}

/** Atalho do item 4-A (só a previsão de término). */
function assertPlannedEndKept(project, endsAtPlanned) {
  assertExecutionFieldsKept(project, { endsAtPlanned });
}

module.exports = {
  PLANNED_END_LOCKED_STATUSES,
  EXECUTION_REQUIRED_FIELDS,
  assertExecutionFieldsKept,
  isBlankDate,
  assertStageEndOnCreate,
  assertStageEndKept,
  assertPlannedEndKept,
};
