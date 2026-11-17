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
 *   enquanto a obra estiver em execução ou depois dela. PLANNED, BUDGETED e READY continuam
 *   sendo preenchidos aos poucos; CANCELLED fica fora.
 */

// Obra que já passou por READY -> ACTIVE (a cadeia do Anexo I depois da execução começar).
const PLANNED_END_LOCKED_STATUSES = Object.freeze(['ACTIVE', 'PAUSED', 'FINAL_INSPECTION', 'DELIVERED', 'WARRANTY', 'CLOSED']);

/** Vazio: null, undefined, texto em branco. Data inválida não é "vazio" (o validador de datas recusa). */
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

/** Edição de obra: depois de READY -> ACTIVE a previsão de término pode ser trocada, nunca apagada. */
function assertPlannedEndKept(project, endsAtPlanned) {
  if (endsAtPlanned === undefined || !isBlankDate(endsAtPlanned)) return;
  if (!PLANNED_END_LOCKED_STATUSES.includes(project.status)) return;
  throw AppError.unprocessable(
    'A obra já está em execução: a previsão de término pode ser alterada, mas não apagada.',
    'PROJECT_PLANNED_END_REQUIRED',
    { field: 'endsAtPlanned', status: project.status }
  );
}

module.exports = {
  PLANNED_END_LOCKED_STATUSES,
  isBlankDate,
  assertStageEndOnCreate,
  assertStageEndKept,
  assertPlannedEndKept,
};
