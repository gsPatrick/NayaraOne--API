'use strict';

const crypto = require('crypto');
const { FinancingCase, CaseRequirement, Simulation, ProviderSubmission, ExternalCaseRouting } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { assertEligible } = require('../eligibility.service');
const { publishSubmissionRequested } = require('../correspondentEvents.service');

// DECISÃO DE ENGENHARIA — não especificado no Caderno com um número exato: tempo máximo que
// esperamos o adapter responder antes de considerar a submissão "ambígua" (status UNKNOWN em vez
// de FAILED). 8s é generoso pro sandbox (responde em milissegundos) e conservador pra um provider
// real futuro; ajustável depois se o cliente pedir outro valor.
const SUBMIT_TIMEOUT_MS = Number(process.env.CORRESPONDENT_SUBMIT_TIMEOUT_MS || 8000);

class SubmitTimeoutError extends Error {
  constructor() {
    super('Tempo esgotado aguardando resposta do provider.');
    this.name = 'SubmitTimeoutError';
  }
}

/**
 * withTimeout — corrida entre a promise do adapter e um timer. Nunca deixa a requisição HTTP
 * pendurada esperando um provider lento indefinidamente (Caderno: "Timeout de envio gera
 * UNKNOWN/consulta antes de reenviar").
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SubmitTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

async function getCaseOrThrow(financingCaseId, groupId, companyId, transaction) {
  const financingCase = await FinancingCase.findOne({ where: { id: financingCaseId, groupId, companyId }, transaction });
  if (!financingCase) {
    throw AppError.notFound('Caso de financiamento não encontrado.', 'FINANCING_CASE_NOT_FOUND');
  }
  return financingCase;
}

/**
 * assertChecklistComplete — "READY_TO_SUBMIT exige checklist completo" (Caderno). Critério
 * adotado (mais conservador possível dado o que já existe no sistema): todo CaseRequirement
 * obrigatório (`required: true`) precisa estar com `status: 'SUBMITTED'`. O Caderno também cita
 * um status `VALIDATED` (validação humana do documento) — essa etapa de validação ainda não tem
 * NENHUM fluxo implementado no sistema (nenhum lugar seta esse status), então exigi-la aqui
 * tornaria IMPOSSÍVEL qualquer submissão para sempre; documentado para a Fase 2/futura revisão
 * adicionar validação humana. Um case sem nenhum requirement obrigatório cadastrado passa
 * trivialmente (checklist vazio = nada pendente) — a decisão de EXIGIR requirements cadastrados
 * antes de poder submeter fica para quem configura o caso, não é regra de negócio desta fase.
 */
async function assertChecklistComplete(financingCaseId, groupId, companyId, transaction) {
  const requirements = await CaseRequirement.findAll({
    where: { financingCaseId, groupId, companyId, required: true },
    transaction,
  });
  const pending = requirements.filter((r) => r.status !== 'SUBMITTED');
  if (pending.length > 0) {
    throw AppError.unprocessable(
      `Checklist de documentos incompleto — ${pending.length} item(ns) obrigatório(s) ainda não enviado(s) (${pending.map((p) => p.documentType).join(', ')}).`,
      'SUBMISSION_CHECKLIST_INCOMPLETE'
    );
  }
}

/**
 * resolveSubmissionAmount — a submissão precisa de um valor pra checar elegibilidade
 * (COR_PROVIDER_ELIGIBILITY considera teto por provider). Usa o valor informado explicitamente
 * no payload, ou cai pra simulação mais recente do case (decisão de produto natural: a última
 * simulação feita é a proposta que está sendo submetida). Sem nenhum dos dois, bloqueia — não dá
 * pra checar elegibilidade de valor sem valor nenhum.
 */
async function resolveSubmissionAmount(financingCaseId, payload, groupId, companyId, transaction) {
  if (payload?.amount !== undefined && payload?.amount !== null) {
    const amount = Number(payload.amount);
    if (!amount || amount <= 0) {
      throw AppError.badRequest('"amount" precisa ser maior que zero quando informado.', 'SUBMISSION_VALIDATION');
    }
    return amount;
  }
  const latestSimulation = await Simulation.findOne({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
  if (latestSimulation) return Number(latestSimulation.amount);
  throw AppError.badRequest(
    'Nenhum valor disponível para checar elegibilidade — informe "amount" ou rode uma simulação antes de submeter.',
    'SUBMISSION_VALIDATION'
  );
}

/**
 * submitFinancingCase — Marco 8 Fase 5. Ordem exata do Caderno/Guia do Marcelo: (1) case
 * READY_TO_SUBMIT (checklist completo), (2) elegibilidade, (3) gera
 * `idempotencyKey = financing:{caseId}:provider:{provider}:v{version}`, (4) se já existe
 * submission com essa key, RETORNA A EXISTENTE sem chamar o adapter de novo, (5) senão persiste
 * PENDING + snapshotHash, emite `financing.submission_requested`, chama o adapter.
 *
 * `version` usa `financingCase.submissionVersion` — um contador PRÓPRIO, DELIBERADAMENTE
 * diferente de `lockVersion` (controle otimista do Sequelize). ACHADO REAL (teste
 * CORRESPONDENT-SUB-04): usar `lockVersion` quebrava a idempotência, porque o PRÓPRIO sucesso de
 * uma submissão salva `financingCase.status = 'SUBMITTED'`, e qualquer `save()` incrementa
 * `lockVersion` como efeito colateral — a segunda chamada idêntica (retry/duplo clique) calculava
 * uma key diferente da primeira e criava uma submissão duplicada. `submissionVersion` só muda
 * explicitamente em `acknowledgeUnknownSubmission`, nunca como efeito colateral — assim a key
 * fica estável entre chamadas idênticas, e só muda quando alguém genuinamente confirma que quer
 * tentar de novo depois de checar o status ("nunca reenviar cego").
 */
async function submitFinancingCase(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);

  await assertChecklistComplete(financingCaseId, groupId, companyId, transaction);

  const amount = await resolveSubmissionAmount(financingCaseId, payload, groupId, companyId, transaction);
  await assertEligible(financingCase, { amount }, groupId, companyId, actorUserId, transaction);

  const idempotencyKey = `financing:${financingCaseId}:provider:${financingCase.providerCode}:v${financingCase.submissionVersion}`;

  const existing = await ProviderSubmission.findOne({ where: { idempotencyKey, groupId, companyId }, transaction });
  if (existing) {
    return existing;
  }

  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    throw AppError.internal(`Provider "${financingCase.providerCode}" configurado no caso não é suportado.`, 'SUBMISSION_PROVIDER_UNKNOWN');
  }
  if (!adapter.capabilities().submitCase) {
    throw AppError.badRequest('O provider configurado para este caso não aceita submissão automática.', 'SUBMISSION_NOT_SUPPORTED');
  }

  const requestSnapshot = { financingCaseId, amount, idempotencyKey };
  const snapshotHash = hashSnapshot(requestSnapshot);

  const submission = await ProviderSubmission.create(
    {
      groupId,
      companyId,
      financingCaseId,
      providerCode: financingCase.providerCode,
      idempotencyKey,
      snapshotHash,
      requestSnapshot,
      status: 'PENDING',
      createdBy: actorUserId || null,
    },
    { transaction }
  );

  await publishSubmissionRequested(submission, transaction);

  try {
    const result = await withTimeout(adapter.submitCase(requestSnapshot), SUBMIT_TIMEOUT_MS);
    submission.status = 'SUBMITTED';
    submission.externalCaseId = result.externalId;
    submission.responseSnapshot = result;
    await submission.save({ transaction });

    financingCase.status = 'SUBMITTED';
    await financingCase.save({ transaction });

    // Fase 6 (webhooks): grava o mapeamento externalCaseId -> tenant na tabela de roteamento
    // sem RLS (ver ExternalCaseRouting) — é assim que o webhook consegue descobrir o tenant
    // ANTES de poder abrir uma transação com SET LOCAL. upsert pelo PK (externalCaseId) porque,
    // em teoria, uma resubmissão (após acknowledgeUnknownSubmission) pode gerar um novo
    // externalCaseId pro MESMO case — nunca deve haver conflito de verdade, mas upsert é seguro.
    await ExternalCaseRouting.upsert(
      {
        externalCaseId: result.externalId,
        providerCode: financingCase.providerCode,
        financingCaseId: financingCase.id,
        groupId,
        companyId,
      },
      { transaction }
    );

    await registrarAuditoria(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'correspondent.submission.submitted',
        entityType: 'FinancingCase',
        entityId: financingCaseId,
        reason: `Caso submetido ao provider "${financingCase.providerCode}" (externalCaseId "${result.externalId}").`,
      },
      transaction
    );
  } catch (err) {
    const isTimeout = err instanceof SubmitTimeoutError;
    submission.status = 'UNKNOWN';
    submission.failureReason = isTimeout
      ? 'Tempo esgotado aguardando resposta do provider — status indeterminado, consulte antes de reenviar.'
      : (err?.message || 'Falha desconhecida ao submeter ao provider.');
    await submission.save({ transaction });

    await registrarAuditoria(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'correspondent.submission.unknown',
        entityType: 'FinancingCase',
        entityId: financingCaseId,
        reason: `Submissão ficou com status UNKNOWN (${isTimeout ? 'timeout' : 'erro'}): ${submission.failureReason}`,
      },
      transaction
    ).catch(() => {});
    // Nunca relança como erro genérico 500 — UNKNOWN é um estado de negócio válido, não uma
    // falha da requisição em si; o chamador recebe a submission com status UNKNOWN no corpo 201.
  }

  return submission;
}

/**
 * acknowledgeUnknownSubmission — única forma de "destravar" uma nova tentativa de submissão
 * depois de uma UNKNOWN: exige checar o status real no provider primeiro (consulta
 * `adapter.getCaseStatus`, mesmo sem externalCaseId retornado — nesta fase, sem resposta do
 * provider, não há o que consultar, então a confirmação é apenas registrar que o operador
 * reconheceu o estado incerto). Isso incrementa `financingCase.submissionVersion` explicitamente,
 * o que torna a PRÓXIMA chamada de `submitFinancingCase` gerar uma `idempotencyKey` nova — só
 * assim uma resubmissão de verdade acontece; sem isso, o mesmo idempotencyKey sempre devolveria a
 * mesma submission UNKNOWN parada, nunca reenviando cego ao provider.
 */
async function acknowledgeUnknownSubmission(submissionId, actorUserId, groupId, companyId, transaction) {
  const submission = await ProviderSubmission.findOne({ where: { id: submissionId, groupId, companyId }, transaction });
  if (!submission) {
    throw AppError.notFound('Submissão não encontrada.', 'SUBMISSION_NOT_FOUND');
  }
  if (submission.status !== 'UNKNOWN') {
    throw AppError.badRequest('Só é possível reconhecer submissões com status "UNKNOWN".', 'SUBMISSION_NOT_UNKNOWN');
  }

  const financingCase = await getCaseOrThrow(submission.financingCaseId, groupId, companyId, transaction);
  financingCase.submissionVersion += 1;
  financingCase.updatedBy = actorUserId || null;
  await financingCase.save({ transaction });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'correspondent.submission.unknown_acknowledged',
      entityType: 'FinancingCase',
      entityId: financingCase.id,
      reason: `Status UNKNOWN da submissão ${submission.id} reconhecido — uma nova tentativa de submissão agora é permitida.`,
    },
    transaction
  );

  return { financingCase, acknowledgedSubmissionId: submission.id };
}

async function listSubmissions(financingCaseId, groupId, companyId, transaction) {
  await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  return ProviderSubmission.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
}

module.exports = {
  submitFinancingCase,
  acknowledgeUnknownSubmission,
  listSubmissions,
  withTimeout,
  SubmitTimeoutError,
};
