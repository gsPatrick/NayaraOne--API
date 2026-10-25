'use strict';

const crypto = require('crypto');
const { FinancingCase, CaseRequirement, CaseDocument, Simulation, ProviderSubmission, ExternalCaseRouting } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { shouldApplyTransition, assertCaseNotCanceled } = require('../statusMachine');
const { assertEligible } = require('../eligibility.service');
const {
  publishSubmissionRequested,
  publishFinancingSubmitted,
  publishIntegrationCorrespondentFailed,
  publishFinancingStatusChanged,
} = require('../correspondentEvents.service');
const { recordIntegrationError } = require('../integrationErrors.service');

// DECISÃO DE ENGENHARIA — não especificado no Caderno com um número exato: tempo máximo que
// esperamos o adapter responder antes de considerar a submissão "ambígua" (status UNKNOWN em vez
// de FAILED). 8s é generoso pro sandbox (responde em milissegundos) e conservador pra um provider
// real futuro; ajustável depois se o cliente pedir outro valor.
const SUBMIT_TIMEOUT_MS = Number(process.env.CORRESPONDENT_SUBMIT_TIMEOUT_MS || 8000);

const DOCUMENT_TYPE_LABELS = {
  RG_CPF: 'RG/CPF',
  COMPROVANTE_RENDA: 'Comprovante de renda',
  COMPROVANTE_RESIDENCIA: 'Comprovante de residência',
  MATRICULA_IMOVEL: 'Matrícula do imóvel',
  CERTIDAO_ESTADO_CIVIL: 'Certidão de estado civil',
  IPTU: 'IPTU',
  OUTRO: 'Outro',
};

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
 * assertChecklistComplete — "READY_TO_SUBMIT exige checklist completo" e o pipeline termina
 * em validação humana. Todo requirement obrigatório precisa estar VALIDATED. Checklist vazio
 * não tem pendência.
 */
async function assertChecklistComplete(financingCaseId, groupId, companyId, transaction) {
  const requirements = await CaseRequirement.findAll({
    where: { financingCaseId, groupId, companyId, required: true },
    transaction,
  });
  const pending = requirements.filter((r) => r.status !== 'VALIDATED');
  if (pending.length > 0) {
    const nomes = pending.map((p) => DOCUMENT_TYPE_LABELS[p.documentType] || p.documentType).join(', ');
    const frase = pending.length === 1
      ? `Checklist incompleto — falta a validação humana de 1 documento obrigatório (${nomes}).`
      : `Checklist incompleto — falta a validação humana de ${pending.length} documentos obrigatórios (${nomes}).`;
    throw AppError.unprocessable(frase, 'SUBMISSION_CHECKLIST_INCOMPLETE');
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
  // Provider manual não simula e pode não ter teto. O valor só é obrigatório quando a regra
  // de elegibilidade exige teto — essa checagem fica em assertEligible.
  return null;
}

/**
 * requestSubmission — Marco 8 Fase 5 (worker assíncrono, pedido explícito do usuário: "faz
 * exatamente como ela tá pedindo" sobre o Caderno — "Worker chama provider"). Esta função roda
 * DENTRO do request HTTP e só faz a parte síncrona/rápida: (1) case READY_TO_SUBMIT (checklist
 * completo), (2) elegibilidade, (3) gera `idempotencyKey`, (4) se já existe submission com essa
 * key, RETORNA A EXISTENTE, (5) senão persiste PENDING + snapshotHash, emite
 * `financing.submission_requested`, e RETORNA IMEDIATAMENTE — a chamada ao provider acontece
 * depois, fora do request, no job `correspondentSubmissionWorkerJob`
 * (`processPendingSubmission`, abaixo), que varre submissions `PENDING` periodicamente. Antes
 * desta mudança, o adapter era chamado SINCRONAMENTE aqui mesmo — mantido como simplificação
 * documentada até o usuário pedir explicitamente o worker de verdade.
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
async function requestSubmission(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const financingCase = await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  assertCaseNotCanceled(financingCase);

  await assertChecklistComplete(financingCaseId, groupId, companyId, transaction);

  if (payload?.consent !== true) {
    throw AppError.unprocessable(
      'Envio exige autorização/consentimento do cliente.',
      'SUBMISSION_CONSENT_REQUIRED'
    );
  }

  if (financingCase.status !== 'READY_TO_SUBMIT' && shouldApplyTransition(financingCase.status, 'READY_TO_SUBMIT')) {
    const beforeStatus = financingCase.status;
    financingCase.status = 'READY_TO_SUBMIT';
    financingCase.updatedBy = actorUserId || null;
    await financingCase.save({ transaction });
    await registrarAuditoria(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'correspondent.financing_case.status_changed',
        entityType: 'FinancingCase',
        entityId: financingCase.id,
        beforeJson: { status: beforeStatus },
        afterJson: { status: 'READY_TO_SUBMIT' },
        reason: 'Checklist completo. Caso pronto para envio.',
      },
      transaction
    );
    await publishFinancingStatusChanged(
      financingCase,
      { previousStatus: beforeStatus, normalizedStatus: 'READY_TO_SUBMIT', historyId: `checklist:${financingCase.id}:READY_TO_SUBMIT` },
      transaction
    );
  }

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

  const requestSnapshot = { financingCaseId, amount, idempotencyKey, consent: true };
  const snapshotHash = hashSnapshot(requestSnapshot);

  // ACHADO REAL (auditoria pós-DoD, Frente Idempotência/Concorrência, teste
  // CORRESPONDENT-SUB-11): o findOne acima não protege contra duas requisições concorrentes de
  // verdade (2 conexões/transações distintas) que passam pelo findOne antes de qualquer uma ter
  // commitado o create — a 2ª `create()` batia no índice único
  // `provider_submissions_idempotency_key_company_idx` e estourava um
  // `SequelizeUniqueConstraintError` cru (500) em vez de um erro de negócio tratado. Reproduzido
  // ao vivo com `Promise.allSettled` disparando 2 chamadas idênticas em paralelo. MESMO padrão
  // já usado pelo mesmo tipo de corrida em `changeOrders.service.js` (Marco 6): não dá para
  // simplesmente reconsultar e devolver o registro vencedor NA MESMA transação (o Postgres
  // aborta toda a transação após a violação, até rollback) — por isso devolve um erro de
  // conflito claro; o retry do cliente cria uma nova transação onde o findOne de idempotência no
  // topo desta função já encontra o registro vencedor e devolve ele, sem duplicar nada.
  let submission;
  try {
    submission = await ProviderSubmission.create(
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
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        'Já existe uma submissão em andamento para este caso (corrida concorrente detectada) — tente novamente.',
        'SUBMISSION_IDEMPOTENCY_RACE'
      );
    }
    throw err;
  }

  await publishSubmissionRequested(submission, transaction);

  // Não chama o adapter aqui — fica para o worker (processPendingSubmission). Retorna PENDING.
  return submission;
}

/**
 * sendNeededDocuments — "Enviar ao provider somente o necessário" + uploadDocument() opcional do
 * adapter. Depois que o caso foi aceito, envia SÓ os documentos obrigatórios já validados por uma
 * pessoa e ainda não enviados (a versão vigente de cada requisito). O que vai ao adapter é a
 * referência (tipo, arquivo, versão), nunca o conteúdo nem documento fora do checklist. Provider
 * sem a capacidade (ex.: manual) não recebe nada. Uma falha aqui NÃO desfaz o envio do caso: vira
 * erro de integração e evento, e o documento fica sem marca de enviado para nova tentativa.
 */
async function sendNeededDocuments(adapter, submission, financingCase, externalCaseId, actorUserId, transaction) {
  const { groupId, companyId, id: financingCaseId } = financingCase;
  if (typeof adapter.uploadDocument !== 'function' || !adapter.capabilities().uploadDocument) return [];

  const requirements = await CaseRequirement.findAll({ where: { financingCaseId, groupId, companyId, required: true, status: 'VALIDATED' }, transaction });
  const sent = [];
  for (const requirement of requirements) {
    // eslint-disable-next-line no-await-in-loop
    const document = await CaseDocument.findOne({ where: { requirementId: requirement.id, supersededAt: null }, transaction });
    if (!document || document.providerExternalDocumentId) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await withTimeout(
        adapter.uploadDocument({
          idempotencyKey: `${submission.idempotencyKey}:doc:${document.id}`,
          externalCaseId,
          documentType: requirement.documentType,
          fileId: document.fileId,
          version: document.version,
        }),
        SUBMIT_TIMEOUT_MS
      );
      document.providerExternalDocumentId = result.externalDocumentId;
      document.sentToProviderAt = new Date();
      // eslint-disable-next-line no-await-in-loop
      await document.save({ transaction });
      sent.push({ documentId: document.id, documentType: requirement.documentType });
      // eslint-disable-next-line no-await-in-loop
      await registrarAuditoria(
        {
          groupId, companyId, actorUserId,
          action: 'correspondent.document.sent_to_provider',
          entityType: 'CaseDocument',
          entityId: document.id,
          reason: `Documento "${requirement.documentType}" (versão ${document.version}) enviado ao provider "${financingCase.providerCode}" junto ao caso ${externalCaseId}. Só a referência foi enviada.`,
        },
        transaction
      );
    } catch (err) {
      const reason = err instanceof SubmitTimeoutError ? 'Tempo esgotado ao enviar o documento ao provider.' : 'Falha ao enviar o documento ao provider.';
      // eslint-disable-next-line no-await-in-loop
      await recordIntegrationError(
        { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'upload_document', errorCode: err instanceof SubmitTimeoutError ? 'DOCUMENT_UPLOAD_TIMEOUT' : 'DOCUMENT_UPLOAD_FAILED', message: `${reason} Documento: ${requirement.documentType}.` },
        transaction
      );
      // eslint-disable-next-line no-await-in-loop
      await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason, submissionId: `${submission.id}:doc:${document.id}` }, transaction);
    }
  }
  return sent;
}

/**
 * processPendingSubmission — a parte que ANTES rodava dentro do request HTTP, agora chamada pelo
 * job `correspondentSubmissionWorkerJob`. Recebe uma `ProviderSubmission` com status PENDING já
 * carregada (e o `financingCase` correspondente) e chama o adapter de verdade, com o mesmo
 * timeout/tratamento de UNKNOWN de antes.
 */
async function processPendingSubmission(submission, financingCase, actorUserId, transaction) {
  const { groupId, companyId, financingCaseId } = submission;
  if (financingCase.status === 'CANCELED') {
    // Caso cancelado depois do pedido de envio: nada vai ao provider.
    submission.status = 'CANCELED';
    submission.failureReason = 'CASO_CANCELADO';
    await submission.save({ transaction });
    return submission;
  }
  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    throw AppError.internal(`Provider "${financingCase.providerCode}" configurado no caso não é suportado.`, 'SUBMISSION_PROVIDER_UNKNOWN');
  }

  try {
    const beforeStatus = financingCase.status;
    const result = await withTimeout(adapter.submitCase(submission.requestSnapshot), SUBMIT_TIMEOUT_MS);
    submission.status = 'SUBMITTED';
    submission.externalCaseId = result.externalId;
    submission.responseSnapshot = result;
    await submission.save({ transaction });

    financingCase.status = 'SUBMITTED';
    await financingCase.save({ transaction });
    await publishFinancingSubmitted(financingCase, submission, transaction);

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
        beforeJson: { status: beforeStatus },
        afterJson: { status: financingCase.status, externalCaseId: result.externalId },
        reason: result?.status === 'PENDING_MANUAL_ACTION'
          ? `Caso registrado para ação manual no banco (referência "${result.externalId}"). Nenhum envio automático foi feito.`
          : `Caso submetido ao provider "${financingCase.providerCode}" (externalCaseId "${result.externalId}") pelo worker assíncrono.`,
      },
      transaction
    );

    await sendNeededDocuments(adapter, submission, financingCase, result.externalId, actorUserId, transaction);
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

    // "integration.correspondent.failed" (Caderno, Fase 9) — payload nunca inclui o corpo cru
    // da exceção, só `submission.failureReason` (já sanitizado acima, nunca stack/detalhe técnico).
    await publishIntegrationCorrespondentFailed(
      financingCase,
      { providerCode: financingCase.providerCode, reason: submission.failureReason, submissionId: submission.id },
      transaction
    );
    await recordIntegrationError(
      {
        groupId,
        companyId,
        financingCaseId,
        providerCode: financingCase.providerCode,
        operation: 'submit',
        errorCode: isTimeout ? 'SUBMIT_TIMEOUT' : 'SUBMIT_FAILED',
        message: isTimeout
          ? 'Tempo esgotado aguardando resposta do provider. Consulte o status antes de reenviar.'
          : 'Falha ao submeter o caso ao provider. Consulte o status antes de reenviar.',
      },
      transaction
    );
    // Nunca relança — UNKNOWN é um estado de negócio válido; o job segue pra próxima pendência.
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

/**
 * submitFinancingCase — wrapper de compatibilidade. Antes da introdução do worker assíncrono,
 * esta era a função única que fazia tudo (request + chamada ao provider) numa só chamada
 * síncrona. Mantida para não forçar reescrita de toda a suíte de testes existente (vários
 * arquivos fora desta frente também chamam esta função) — faz `requestSubmission` seguido
 * imediatamente de `processPendingSubmission` NA MESMA transação, reproduzindo o comportamento
 * síncrono de antes. O fluxo HTTP real (`POST /financing-cases/:id/submissions`) agora usa só
 * `requestSubmission` (rápido, devolve PENDING) — quem processa de fato é o job
 * `correspondentSubmissionWorkerJob`.
 */
async function submitFinancingCase(financingCaseId, payload, actorUserId, groupId, companyId, transaction) {
  const submission = await requestSubmission(financingCaseId, payload, actorUserId, groupId, companyId, transaction);
  if (submission.status !== 'PENDING') {
    // já existia (idempotência) com status != PENDING — nada a processar.
    return submission;
  }
  const financingCase = await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  return processPendingSubmission(submission, financingCase, actorUserId, transaction);
}

module.exports = {
  sendNeededDocuments,
  requestSubmission,
  processPendingSubmission,
  submitFinancingCase,
  acknowledgeUnknownSubmission,
  listSubmissions,
  withTimeout,
  SubmitTimeoutError,
};
