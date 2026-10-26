'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { File, FinancingCase, CaseRequirement, CaseDocument, CaseApplicant, Simulation, ProviderSubmission, ProviderStatusHistory } = require('../../../models');
const { sequelize } = require('../../../models');
const AppError = require('../../../utils/AppError');
const { registrarAuditoria } = require('../../../engines/audit/auditLog.service');
const { resolveFinancingProviderAdapterByCode } = require('../adapters/resolveFinancingProviderAdapter');
const { shouldApplyTransition, assertCaseNotCanceled } = require('../statusMachine');
const { assertEligible, resolveEligibilityConfig, getProviderTimeoutMs, providerTimeoutMs } = require('../eligibility.service');
const { claimExternalRouting } = require('../externalRouting');
const { scheduleWebhookReprocess, afterRootCommit } = require('../webhookPending.service');
const logger = require('../../../utils/logger');
const {
  publishSubmissionRequested,
  publishFinancingSubmitted,
  publishIntegrationCorrespondentFailed,
  publishFinancingStatusChanged,
} = require('../correspondentEvents.service');
const { recordIntegrationError } = require('../integrationErrors.service');
const { sanitizeProviderMessage } = require('../sanitizeProviderMessage');
const { safeAudit } = require('../safeAudit');
const { syncOpportunityFromFinancingCase, STATUS_LABEL_PT } = require('../correspondentCrmSync.service');

// Tempo máximo de espera do provider antes de tratar o envio como incerto (UNKNOWN): o valor da empresa vem de
// Parâmetros (providerTimeoutSeconds). Este é só o último recurso quando ninguém informou o tempo; variável de
// ambiente inválida (texto, zero, negativa) é ignorada: um NaN faria o timer disparar na hora.
const FALLBACK_TIMEOUT_MS = (() => {
  const fromEnv = Number(process.env.CORRESPONDENT_SUBMIT_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 1000 && fromEnv <= 120000 ? fromEnv : 8000;
})();

// Maior valor que cabe nas colunas DECIMAL(14,2).
const MAX_OPERATION_AMOUNT = 999999999999.99;
// Etapas em que o caso ainda pode ser enviado ao provider (o caderno manda carregar o caso pronto para envio).
const SUBMITTABLE_STATUSES = ['DRAFT', 'DOCUMENTS_PENDING', 'READY_TO_SUBMIT'];

// Tradução dos motivos internos de falha da submissão para o texto mostrado na tela.
const FAILURE_REASON_LABEL = {
  CASO_CANCELADO: 'O caso foi cancelado antes de o envio terminar.',
  CASO_CANCELADO_PELO_PROVIDER: 'O provider cancelou o caso.',
  PROVEDOR_INDISPONIVEL: 'O provider não está disponível neste ambiente.',
  ENVIO_EM_ANDAMENTO: 'Envio em andamento: aguardando a resposta do provider.',
  FINALIZACAO_LOCAL_PENDENTE: 'O provider aceitou o caso e o registro local será concluído automaticamente.',
  FINALIZACAO_LOCAL_FALHOU: 'O provider aceitou o caso, mas o registro local falhou. Verifique o caso e o identificador externo.',
  SUBSTITUIDA_POR_NOVO_ENVIO: 'Envio incerto encerrado: um novo envio foi liberado depois de consultar o provider.',
  CONFLITO_ID_EXTERNO: 'O provider devolveu um identificador que já pertence a outro caso. Confira com o provider antes de reenviar.',
};
function failureReasonLabel(reason) {
  if (!reason) return null;
  if (FAILURE_REASON_LABEL[reason]) return FAILURE_REASON_LABEL[reason];
  if (String(reason).startsWith('NAO_PODE_ENVIAR: ')) return `O envio foi cancelado: ${String(reason).slice('NAO_PODE_ENVIAR: '.length)}`;
  return String(reason);
}

// Quando o processo é de produção, as etapas que precisam de várias transações curtas (roteamento do
// webhook, envio de documentos, aviso de cancelamento) usam transações próprias. Nos testes tudo roda
// dentro da transação do teste (que volta no fim); a chave abaixo permite ligar o modo de produção em um teste.
let detachedCommits = process.env.NODE_ENV !== 'test';
function isDetachedCommits() { return detachedCommits; }
function setDetachedCommitsForTest(value) { detachedCommits = Boolean(value); }

function detachedRunTx(groupId, companyId) {
  return (fn) => sequelize.transaction(async (tx) => {
    await sequelize.query('SELECT set_config(\'app.group_id\', :groupId, true), set_config(\'app.company_id\', :companyId, true)', { replacements: { groupId, companyId }, transaction: tx });
    return fn(tx);
  });
}

function normalizeOperationAmount(raw) {
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_OPERATION_AMOUNT) {
    throw AppError.badRequest('Informe um valor da operação maior que zero e dentro do limite permitido.', 'SUBMISSION_VALIDATION');
  }
  return Math.round(amount * 100) / 100;
}

// O identificador do caso no provider precisa caber na coluna (160) e ser texto: sem ele não dá para vincular nem consultar.
function validExternalId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 160;
}

const DOCUMENT_TYPE_LABELS = {
  RG_CPF: 'RG/CPF',
  COMPROVANTE_RENDA: 'Comprovante de renda',
  COMPROVANTE_RESIDENCIA: 'Comprovante de residência',
  MATRICULA_IMOVEL: 'Matrícula do imóvel',
  CERTIDAO_ESTADO_CIVIL: 'Certidão de estado civil',
  IPTU: 'IPTU',
  EXTRATO_BANCARIO: 'Extrato bancário',
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
  const wait = Number.isFinite(ms) && ms > 0 ? ms : FALLBACK_TIMEOUT_MS;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new SubmitTimeoutError()), wait);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// JSON com as chaves em ordem alfabética em todos os níveis: o hash não depende da ordem em que o objeto foi montado.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashSnapshot(snapshot) {
  // A hora do consentimento fica no snapshot (prova), mas fora do hash: o mesmo conteúdo gera o mesmo hash.
  const { consent, ...rest } = snapshot;
  const stable = { ...rest, consent: consent ? { given: consent.given, byUserId: consent.byUserId, evidence: consent.evidence || null, coversPersonIds: consent.coversPersonIds || null } : consent };
  return crypto.createHash('sha256').update(stableStringify(stable)).digest('hex');
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
    where: { financingCaseId, groupId, companyId, required: true, status: { [Op.notIn]: ['EXPIRED', 'DISPENSED'] } },
    transaction,
  });
  if (requirements.length === 0) {
    throw AppError.unprocessable(
      'O checklist deste caso está vazio. Adicione ao menos um documento obrigatório e valide-o antes de enviar.',
      'SUBMISSION_CHECKLIST_EMPTY'
    );
  }
  // Checklist mínimo definido pela empresa (Parâmetros): cada tipo exigido precisa estar no checklist.
  const { action: eligibilityAction } = await resolveEligibilityConfig(groupId, companyId, transaction, null);
  const minimum = Array.isArray(eligibilityAction.requiredDocumentTypes) ? eligibilityAction.requiredDocumentTypes : [];
  // Item dispensado por uma pessoa (com motivo e auditoria) conta como atendido para o checklist mínimo.
  const dispensed = await CaseRequirement.findAll({ where: { financingCaseId, groupId, companyId, status: 'DISPENSED' }, attributes: ['documentType'], transaction });
  const missingTypes = minimum.filter((type) => !requirements.some((r) => r.documentType === type) && !dispensed.some((r) => r.documentType === type));
  if (missingTypes.length) {
    throw AppError.unprocessable(
      `O checklist deste caso não tem todos os documentos exigidos pela empresa. Falta adicionar: ${missingTypes.map((t) => DOCUMENT_TYPE_LABELS[t] || t).join(', ')}.`,
      'SUBMISSION_CHECKLIST_MINIMUM_MISSING'
    );
  }

  // Documento já vencido que o job ainda não varreu também não vale: conta como pendente.
  const validatedIds = requirements.filter((r) => r.status === 'VALIDATED').map((r) => r.id);
  const expiredIds = new Set();
  if (validatedIds.length) {
    const overdue = await CaseDocument.findAll({
      where: { requirementId: validatedIds, supersededAt: null, expiresAt: { [Op.lt]: new Date() } },
      transaction,
    });
    overdue.forEach((d) => expiredIds.add(d.requirementId));
  }
  const pending = requirements.filter((r) => r.status !== 'VALIDATED' || expiredIds.has(r.id));
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
async function resolveSubmissionAmount(financingCase, payload, groupId, companyId, transaction) {
  if (payload?.amount !== undefined && payload?.amount !== null && payload?.amount !== '') {
    return { amount: normalizeOperationAmount(payload.amount), simulation: null };
  }
  // Só vale a última simulação do MESMO provider do caso: simulação de outro banco tem outras condições.
  const latestSimulation = await Simulation.findOne({
    where: { financingCaseId: financingCase.id, groupId, companyId, providerCode: financingCase.providerCode },
    order: [['created_at', 'DESC']],
    transaction,
  });
  if (latestSimulation) return { amount: normalizeOperationAmount(latestSimulation.amount), simulation: latestSimulation };
  // Provider manual não simula e pode não ter teto. O valor só é obrigatório quando a regra
  // de elegibilidade exige teto (assertEligible) ou o provider abre o caso sozinho (conferido no envio).
  return { amount: null, simulation: null };
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

  // Repetir o mesmo pedido (retry, duplo clique) devolve o envio que já existe, mesmo que o checklist
  // tenha sido reaberto depois (documento vencido): a idempotência vem antes das demais checagens.
  {
    const earlyKey = `financing:${financingCaseId}:provider:${financingCase.providerCode}:v${financingCase.submissionVersion}`;
    const early = await ProviderSubmission.findOne({ where: { idempotencyKey: earlyKey, groupId, companyId }, transaction });
    if (early && !['CANCELED', 'FAILED'].includes(early.status)) return early;
  }

  // Caso que o provider já aceitou não é enviado de novo (a versão da chave não é a única proteção).
  {
    const accepted = await ProviderSubmission.findOne({ where: { financingCaseId, groupId, companyId, status: 'SUBMITTED' }, transaction });
    if (accepted) {
      throw AppError.conflict(
        financingCase.status === 'REJECTED'
          ? 'O banco recusou este caso. Para tentar de novo, crie um novo caso (o sistema não trata como duplicata um caso recusado).'
          : 'Este caso já foi aceito pelo provider. Não é possível enviar de novo.',
        'SUBMISSION_ALREADY_ACCEPTED'
      );
    }
  }

  // O envio só parte de um caso ainda não enviado: um caso em análise, recusado ou concluído (status registrado à mão,
  // por exemplo) não abre outro caso no provider.
  if (!SUBMITTABLE_STATUSES.includes(financingCase.status)) {
    throw AppError.unprocessable(
      `Um caso na etapa "${STATUS_LABEL_PT[financingCase.status] || financingCase.status}" não pode ser enviado ao provider. O envio só é feito antes de o caso ser enviado.`,
      'SUBMISSION_CASE_STATUS_NOT_ALLOWED'
    );
  }

  if (financingCase.duplicateReviewStatus === 'PENDING') {
    const { action } = await resolveEligibilityConfig(groupId, companyId, transaction, actorUserId);
    if (action.blockSubmissionOnPendingDuplicate === true) {
      throw AppError.unprocessable(
        'Este caso é uma possível duplicata e ainda aguarda revisão. Revise o caso antes de enviar (a empresa configurou bloquear o envio nesse caso).',
        'SUBMISSION_DUPLICATE_REVIEW_PENDING'
      );
    }
  }

  await assertChecklistComplete(financingCaseId, groupId, companyId, transaction);

  if (payload?.consent !== true) {
    throw AppError.unprocessable(
      'Envio exige autorização/consentimento do cliente.',
      'SUBMISSION_CONSENT_REQUIRED'
    );
  }
  const consentEvidence = payload?.consentEvidence ? String(payload.consentEvidence).trim().slice(0, 300) : '';
  {
    const { action } = await resolveEligibilityConfig(groupId, companyId, transaction, actorUserId);
    const minEvidence = Number.isInteger(action.consentEvidenceMinLength) && action.consentEvidenceMinLength >= 1 ? action.consentEvidenceMinLength : 5;
    if (action.requireConsentEvidence === true && consentEvidence.length < minEvidence) {
      throw AppError.unprocessable(
        `Informe como o cliente autorizou o envio (ex.: assinatura, WhatsApp, e-mail), com ao menos ${minEvidence} caracteres.`,
        'SUBMISSION_CONSENT_EVIDENCE_REQUIRED'
      );
    }
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
    // O histórico de status é append-only: a passagem interna para "pronto para envio" também deixa linha.
    const readyHistory = await ProviderStatusHistory.create(
      { groupId, companyId, financingCaseId, rawProviderStatus: 'READY_TO_SUBMIT', normalizedStatus: 'READY_TO_SUBMIT', source: 'checklist', applied: true, occurredAt: new Date() },
      { transaction }
    );
    await publishFinancingStatusChanged(
      financingCase,
      { previousStatus: beforeStatus, normalizedStatus: 'READY_TO_SUBMIT', historyId: readyHistory.id },
      transaction
    );
  }

  const { amount, simulation } = await resolveSubmissionAmount(financingCase, payload, groupId, companyId, transaction);
  const eligibility = await assertEligible(financingCase, { amount }, groupId, companyId, actorUserId, transaction);

  let idempotencyKey = `financing:${financingCaseId}:provider:${financingCase.providerCode}:v${financingCase.submissionVersion}`;

  let existing = await ProviderSubmission.findOne({ where: { idempotencyKey, groupId, companyId }, transaction });
  if (existing && ['CANCELED', 'FAILED'].includes(existing.status)) {
    // Submissão que o worker cancelou (ex.: provider ficou inelegível por um tempo) ou que o provider recusou de forma
    // definitiva nunca abriu o caso lá: um novo pedido usa uma chave nova, em vez de devolver a antiga para sempre.
    financingCase.submissionVersion += 1;
    await financingCase.save({ transaction });
    idempotencyKey = `financing:${financingCaseId}:provider:${financingCase.providerCode}:v${financingCase.submissionVersion}`;
    existing = await ProviderSubmission.findOne({ where: { idempotencyKey, groupId, companyId }, transaction });
  }
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
  // Provider que abre o caso sozinho precisa do valor; só o fluxo manual (sem API) pode seguir sem ele.
  if (amount === null && adapter.capabilities().simulate) {
    throw AppError.badRequest('Informe o valor da operação (ou rode uma simulação neste provider) antes de enviar.', 'SUBMISSION_VALIDATION');
  }

  // Foto do que está sendo enviado: quem são os proponentes, quais documentos (só referência),
  // quem consentiu e quando, e qual versão da regra de elegibilidade liberou o envio.
  const applicants = await CaseApplicant.findAll({ where: { financingCaseId, groupId, companyId }, order: [['id', 'ASC']], transaction });
  const validatedRequirementIds = (await CaseRequirement.findAll({ where: { financingCaseId, groupId, companyId, required: true, status: 'VALIDATED' }, attributes: ['id'], transaction })).map((r) => r.id);
  const validatedRequirements = validatedRequirementIds.length ? await CaseRequirement.findAll({ where: { id: validatedRequirementIds }, attributes: ['id', 'documentType'], transaction }) : [];
  const typeByRequirement = new Map(validatedRequirements.map((r) => [r.id, r.documentType]));
  const currentDocs = validatedRequirementIds.length
    ? await CaseDocument.findAll({ where: { financingCaseId, groupId, companyId, supersededAt: null, requirementId: validatedRequirementIds }, order: [['id', 'ASC']], transaction })
    : [];
  const checksumByFile = new Map();
  if (currentDocs.length) {
    const files = await File.findAll({ where: { id: currentDocs.map((d) => d.fileId) }, attributes: ['id', 'checksumSha256'], transaction });
    files.forEach((f) => checksumByFile.set(f.id, f.checksumSha256));
  }
  const requestSnapshot = {
    financingCaseId,
    amount,
    idempotencyKey,
    // Provider e simulação usada ficam na prova do que foi enviado (o hash depende deles).
    providerCode: financingCase.providerCode,
    simulation: simulation ? { id: simulation.id, termMonths: simulation.termMonths, rate: simulation.rate, monthlyPayment: simulation.monthlyPayment } : null,
    // O aceite vale para todos os proponentes do caso no momento do envio; a lista deles fica registrada como prova.
    consent: { given: true, byUserId: actorUserId || null, at: new Date().toISOString(), evidence: consentEvidence || null, coversPersonIds: applicants.map((ap) => ap.personId).sort() },
    applicants: applicants.map((ap) => ({ personId: ap.personId, role: ap.role })),
    // Só o tipo, a versão e o hash do arquivo: o snapshot não carrega a referência ao arquivo restrito.
    documents: currentDocs.map((d) => ({ documentType: typeByRequirement.get(d.requirementId) || null, version: d.version, checksumSha256: checksumByFile.get(d.fileId) || null })),
    eligibilityRuleVersionId: eligibility?.ruleVersionId || null,
  };
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

// ---------------------------------------------------------------------------------------------
// Envio de documentos ao provider
// ---------------------------------------------------------------------------------------------

class DocumentIdInvalidError extends Error {
  constructor() {
    super('O provider devolveu um identificador de documento inválido.');
    this.name = 'DocumentIdInvalidError';
  }
}

function validExternalDocumentId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new DocumentIdInvalidError();
  return value.trim();
}

/**
 * uploadDocumentSafely — "consultar antes de reenviar": quando o adapter sabe procurar o documento pela chave de
 * idempotência (`findDocumentByKey`), a consulta vem antes do envio; um timeout anterior (o documento pode ter
 * subido) nunca vira um reenvio às cegas. O identificador devolvido é validado (texto, até 128 caracteres).
 */
async function uploadDocumentSafely(adapter, request, timeoutMs) {
  if (typeof adapter.findDocumentByKey === 'function') {
    const known = await withTimeout(adapter.findDocumentByKey(request.idempotencyKey), timeoutMs);
    if (known && known.found && known.externalDocumentId) return validExternalDocumentId(known.externalDocumentId);
  }
  const result = await withTimeout(adapter.uploadDocument(request), timeoutMs);
  return validExternalDocumentId(result?.externalDocumentId);
}

function documentFailureOf(err) {
  if (err instanceof SubmitTimeoutError) {
    return {
      code: 'DOCUMENT_UPLOAD_TIMEOUT',
      reason: 'Tempo esgotado ao enviar o documento ao provider. Ele pode ter sido recebido: ao reenviar, o sistema consulta o provider antes de enviar de novo.',
    };
  }
  if (err instanceof DocumentIdInvalidError) return { code: 'DOCUMENT_UPLOAD_INVALID_RESPONSE', reason: 'O provider respondeu ao envio do documento sem um identificador válido.' };
  return { code: 'DOCUMENT_UPLOAD_FAILED', reason: 'Falha ao enviar o documento ao provider.' };
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
  const timeoutMs = await getProviderTimeoutMs(groupId, companyId, transaction);

  const requirements = await CaseRequirement.findAll({ where: { financingCaseId, groupId, companyId, required: true, status: 'VALIDATED' }, transaction });
  const sent = [];
  for (const requirement of requirements) {
    // eslint-disable-next-line no-await-in-loop
    const document = await CaseDocument.findOne({ where: { requirementId: requirement.id, supersededAt: null }, transaction });
    if (!document || document.providerExternalDocumentId) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const externalDocumentId = await uploadDocumentSafely(adapter, {
        idempotencyKey: `${submission.idempotencyKey}:doc:${document.id}`,
        externalCaseId,
        documentType: requirement.documentType,
        fileId: document.fileId,
        version: document.version,
      }, timeoutMs);
      document.providerExternalDocumentId = externalDocumentId;
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
          reason: `Documento "${DOCUMENT_TYPE_LABELS[requirement.documentType] || requirement.documentType}" (versão ${document.version}) enviado ao provider "${financingCase.providerCode}" junto ao caso ${externalCaseId}. Só a referência foi enviada.`,
        },
        transaction
      );
    } catch (err) {
      const failure = documentFailureOf(err);
      // eslint-disable-next-line no-await-in-loop
      await recordIntegrationError(
        { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'upload_document', errorCode: failure.code, message: `${failure.reason} Documento: ${DOCUMENT_TYPE_LABELS[requirement.documentType] || requirement.documentType}.` },
        transaction
      );
      // eslint-disable-next-line no-await-in-loop
      await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: failure.reason, submissionId: `doc:${document.id}:${Date.now()}` }, transaction);
    }
  }
  return sent;
}

async function markSubmissionUnknown(submission, financingCase, err, transaction) {
  const { groupId, companyId, financingCaseId } = submission;
  const isTimeout = err instanceof SubmitTimeoutError;
  submission.status = 'UNKNOWN';
  submission.failureReason = isTimeout
    ? 'Tempo esgotado aguardando resposta do provider — status indeterminado, consulte antes de reenviar.'
    : sanitizeProviderMessage(err?.message, 'Falha desconhecida ao submeter ao provider.');
  await submission.save({ transaction });

  await safeAudit(
    {
      groupId,
      companyId,
      actorUserId: null,
      action: 'correspondent.submission.unknown',
      entityType: 'FinancingCase',
      entityId: financingCaseId,
      reason: `Submissão ficou com status UNKNOWN (${isTimeout ? 'timeout' : 'erro'}): ${submission.failureReason}`,
    },
    transaction
  );

  // "integration.correspondent.failed" (Caderno, Fase 9): payload nunca inclui o corpo cru da
  // exceção, só `submission.failureReason` (já sanitizado acima, nunca stack/detalhe técnico).
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
}

/**
 * isDefinitiveProviderError — recusa que o provider deixou clara (ex.: 4xx de validação): nada foi aberto lá, então
 * o envio pode ser refeito. Timeout, erro de rede e qualquer erro sem esse sinal continuam ambíguos (UNKNOWN):
 * pode ter chegado, e nunca se reenvia às cegas.
 */
function isDefinitiveProviderError(err) {
  if (!err || err instanceof SubmitTimeoutError) return false;
  if (err.definitive === true) return true;
  const status = Number(err.statusCode || err.status || err.httpStatus);
  return Number.isInteger(status) && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

async function markSubmissionFailed(submission, financingCase, err, transaction) {
  const { groupId, companyId, financingCaseId } = submission;
  submission.status = 'FAILED';
  submission.failureReason = sanitizeProviderMessage(err?.message, 'O provider recusou o envio.');
  await submission.save({ transaction });
  await safeAudit(
    {
      groupId,
      companyId,
      actorUserId: null,
      action: 'correspondent.submission.failed',
      entityType: 'FinancingCase',
      entityId: financingCaseId,
      reason: `O provider recusou o envio de forma definitiva: ${submission.failureReason} Corrija o apontado e envie de novo.`,
    },
    transaction
  );
  await publishIntegrationCorrespondentFailed(
    financingCase,
    { providerCode: financingCase.providerCode, reason: submission.failureReason, submissionId: submission.id },
    transaction
  );
  await recordIntegrationError(
    { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'submit', errorCode: 'SUBMIT_REJECTED', message: `O provider recusou o envio: ${submission.failureReason} Corrija o apontado e envie de novo.` },
    transaction
  );
}

const ORIGIN_TEXT = {
  worker: 'pelo worker assíncrono',
  manual_recovery: 'por recuperação manual (uma pessoa consultou o provider)',
  auto_recovery: 'por recuperação automática (consulta ao provider)',
  local_retry: 'ao retomar o registro local (o provider já tinha aceitado o caso)',
};

/**
 * finalizeAcceptedSubmission — tudo o que acontece DEPOIS de o provider aceitar o caso (envio
 * normal ou recuperado por consulta de uma submissão UNKNOWN): grava a submissão, o status, o
 * histórico, os eventos, o roteamento de webhook e envia os documentos exigidos.
 */
async function finalizeAcceptedSubmission(adapter, submission, financingCase, result, actorUserId, transaction, { sendDocuments = true, origin = 'worker' } = {}) {
  const { groupId, companyId, financingCaseId } = submission;
  if (!result || !validExternalId(result.externalId)) {
    throw AppError.unprocessable('O provider devolveu um identificador de caso inválido.', 'SUBMISSION_EXTERNAL_ID_INVALID');
  }
  const beforeStatus = financingCase.status;
  submission.status = 'SUBMITTED';
  submission.failureReason = null;
  submission.externalCaseId = result.externalId;
  submission.responseSnapshot = result;
  await submission.save({ transaction });

  // Status do caso = o que o provider devolveu (normalizado), no mínimo SUBMITTED: uma recuperação tardia de um
  // UNKNOWN cujo provider já respondeu APPROVED leva o caso a APPROVED. Caso cancelado, recusado ou já adiante
  // nunca é rebaixado nem ressuscitado.
  const reportedStatus = (adapter.normalizeProviderStatus && adapter.normalizeProviderStatus(result?.status)) || 'SUBMITTED';
  const targetStatus = shouldApplyTransition(financingCase.status, reportedStatus) ? reportedStatus : 'SUBMITTED';
  const advances = shouldApplyTransition(financingCase.status, targetStatus);
  if (advances) {
    financingCase.status = targetStatus;
    await financingCase.save({ transaction });
  }
  // O histórico de status é append-only e tem de mostrar também a transição para SUBMITTED, com
  // o evento financing.status.changed (antes só os webhooks e o registro manual deixavam rastro).
  const historyEntry = await ProviderStatusHistory.create(
    {
      groupId,
      companyId,
      financingCaseId,
      rawProviderStatus: String(result?.status || 'SUBMITTED').slice(0, 255),
      normalizedStatus: reportedStatus,
      source: 'submission',
      applied: advances,
      occurredAt: new Date(),
    },
    { transaction }
  );
  const manualProvider = result?.status === 'PENDING_MANUAL_ACTION';
  if (advances) {
    await publishFinancingStatusChanged(
      financingCase,
      { previousStatus: beforeStatus, normalizedStatus: targetStatus, historyId: historyEntry.id },
      transaction
    );
  }
  await publishFinancingSubmitted(financingCase, submission, transaction);
  if (advances) {
    await syncOpportunityFromFinancingCase(financingCase, targetStatus, transaction, { manual: manualProvider });
    if (result?.proposal && ['APPROVED', 'CONTRACTING'].includes(targetStatus)) {
      try {
        const { recordProposal } = require('./caseWorkflow.service');
        await sequelize.transaction({ transaction }, (savepoint) => recordProposal(financingCase, result.proposal, 'PROVIDER', null, savepoint));
      } catch (err) {
        // Proposta malformada não desfaz a recuperação, mas também não some em silêncio: vira erro de integração visível.
        await recordIntegrationError(
          { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'webhook.proposal', errorCode: typeof err?.code === 'string' ? err.code : 'PROPOSAL_INVALID', message: `A proposta devolvida pelo provider não pôde ser registrada: ${sanitizeProviderMessage(err?.message, 'proposta inválida')}` },
          transaction
        );
        await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: 'A proposta devolvida pelo provider não pôde ser registrada.', submissionId: `proposal:${submission.id}` }, transaction);
      }
    }
  }

  // Fase 6 (webhooks): grava o mapeamento (provider, externalCaseId) -> tenant na tabela de
  // roteamento sem RLS (ver ExternalCaseRouting) — é assim que o webhook descobre o tenant ANTES
  // de poder abrir uma transação com SET LOCAL. Nunca toma o roteamento de outro dono.
  await claimExternalRouting(financingCase, result.externalId, transaction);
  // Webhooks que chegaram antes do roteamento ficaram guardados: são reprocessados depois do commit.
  scheduleWebhookReprocess(transaction, financingCase.providerCode, result.externalId);

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
      reason: manualProvider
        ? `Caso registrado para ação manual no banco (referência "${result.externalId}"). Nenhum envio automático foi feito.`
        : `Caso submetido ao provider "${financingCase.providerCode}" (externalCaseId "${result.externalId}") ${ORIGIN_TEXT[origin] || ORIGIN_TEXT.worker}.`,
    },
    transaction
  );

  if (sendDocuments) {
    // O caso já foi aceito pelo provider: falha no envio dos documentos NÃO desfaz a submissão nem a
    // marca como UNKNOWN. Roda num savepoint e, se falhar, vira erro de integração visível.
    try {
      await sequelize.transaction({ transaction }, async (savepoint) => {
        await sendNeededDocuments(adapter, submission, financingCase, result.externalId, actorUserId, savepoint);
      });
    } catch (err) {
      await recordIntegrationError(
        {
          groupId,
          companyId,
          financingCaseId,
          providerCode: financingCase.providerCode,
          operation: 'upload_document',
          errorCode: 'UPLOAD_FAILED',
          message: 'O caso foi enviado, mas houve falha ao enviar os documentos ao provider. Reenvie os documentos pendentes.',
        },
        transaction
      );
    }
  } else {
    // Quem recuperou o envio (consulta, recuperação automática, retomada local) não manda os documentos dentro da
    // trava: eles seguem logo depois do commit, fora de qualquer trava.
    scheduleDocumentSend(transaction, financingCase, submission.id, actorUserId);
  }
}

/**
 * scheduleDocumentSend — depois do commit, envia ao provider os documentos validados ainda não enviados (cada
 * chamada numa transação curta). Só no modo de produção; nos testes o envio é chamado explicitamente.
 */
function scheduleDocumentSend(transaction, financingCase, submissionId, actorUserId) {
  if (!isDetachedCommits() || !transaction) return;
  const { groupId, companyId, id: financingCaseId } = financingCase;
  afterRootCommit(transaction, () => {
    sendNeededDocumentsDetached(detachedRunTx(groupId, companyId), financingCaseId, submissionId, actorUserId).catch((err) => {
      logger.warn({ financingCaseId, err: sanitizeProviderMessage(err?.message) }, 'Falha ao enviar os documentos validados ao provider depois da recuperação do envio.');
    });
  });
}

// Códigos de recusa por regra de negócio (elegibilidade, checklist, valor): o envio é cancelado com o motivo.
// Qualquer outro erro (configuração ausente, falha técnica) deixa a submissão pendente para nova tentativa.
function isBusinessBlock(err) {
  const code = String(err?.code || '');
  if (code === 'COR_ELIGIBILITY_NOT_CONFIGURED') return false;
  return code.startsWith('COR_ELIGIBILITY_') || code.startsWith('SUBMISSION_CHECKLIST_') || code === 'SUBMISSION_VALIDATION';
}

async function recordOpenErrorOnce(entry, transaction) {
  const { IntegrationError } = require('../../../models');
  const already = await IntegrationError.findOne({ where: { financingCaseId: entry.financingCaseId, errorCode: entry.errorCode, status: 'OPEN' }, transaction });
  if (already) return;
  await recordIntegrationError(entry, transaction);
}

/**
 * preflightSubmission — tudo que se confere ANTES de chamar o provider: caso cancelado, provider
 * indisponível, provider que deixou de ser elegível e checklist que deixou de estar completo entre o
 * pedido e o worker. Devolve o adapter quando o envio pode seguir; senão marca a submissão como
 * CANCELED (com o motivo) e devolve null. Erro técnico (ex.: configuração de elegibilidade fora do ar)
 * NÃO cancela: a submissão continua pendente e o erro fica visível.
 */
async function preflightSubmission(submission, financingCase, actorUserId, transaction) {
  const { groupId, companyId, financingCaseId } = submission;
  const cancel = async (reason) => {
    submission.status = 'CANCELED';
    submission.failureReason = reason;
    await submission.save({ transaction });
    return null;
  };
  if (financingCase.status === 'CANCELED') return cancel('CASO_CANCELADO');
  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter) {
    // Provider que não existe neste ambiente: não fica PENDING para sempre; vira cancelada, com erro visível.
    await cancel('PROVEDOR_INDISPONIVEL');
    await recordIntegrationError(
      { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'submit', errorCode: 'PROVIDER_UNAVAILABLE', message: `O provider "${financingCase.providerCode}" não está disponível neste ambiente. Escolha outro provider para o caso.` },
      transaction
    );
    await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: 'Provider indisponível neste ambiente.', submissionId: `preflight:${submission.id}` }, transaction);
    return null;
  }
  try {
    await assertEligible(financingCase, { amount: submission.requestSnapshot?.amount }, groupId, companyId, actorUserId, transaction);
    await assertChecklistComplete(financingCaseId, groupId, companyId, transaction);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (isBusinessBlock(err)) {
      await cancel(`NAO_PODE_ENVIAR: ${sanitizeProviderMessage(err.message)}`);
      await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: sanitizeProviderMessage(err.message), submissionId: `preflight:${submission.id}` }, transaction);
      return null;
    }
    // Falha de configuração/técnica: não cancela. O envio segue pendente e uma pessoa vê o motivo.
    await recordOpenErrorOnce(
      { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'submit', errorCode: 'SUBMIT_PREFLIGHT_BLOCKED', message: `O envio está aguardando: ${sanitizeProviderMessage(err.message)}` },
      transaction
    );
    return null;
  }
  return adapter;
}

/** callProviderSubmit — a única parte ambígua: só ela pode virar UNKNOWN ou FAILED. Nunca lança. */
async function callProviderSubmit(adapter, submission, timeoutMs) {
  try {
    // O provider recebe só o necessário para abrir o caso (documentos seguem por uploadDocument, só referência).
    const { financingCaseId: caseRef, amount: amountRef, idempotencyKey: keyRef } = submission.requestSnapshot;
    const result = await withTimeout(adapter.submitCase({ financingCaseId: caseRef, amount: amountRef, idempotencyKey: keyRef, consent: true }), timeoutMs);
    return { result };
  } catch (error) {
    return { error };
  }
}

/**
 * commitExternalRouting — grava o roteamento (provider + id externo → empresa/caso) numa transação
 * própria e curta, ANTES do resto: um webhook disparado logo depois da aceitação já encontra o caso.
 * Nunca toma o roteamento de outra empresa: se o id já é de outra empresa, é conflito.
 */
async function commitExternalRouting(financingCase, externalId) {
  await sequelize.transaction(async (routingTx) => {
    await claimExternalRouting(financingCase, externalId, routingTx);
  });
  // Roteamento já confirmado: os webhooks que chegaram antes são reprocessados.
  scheduleWebhookReprocess(null, financingCase.providerCode, externalId);
}

/**
 * Conflito de identificador externo: o provider devolveu um id que já pertence a outro caso. O envio fica incerto
 * (UNKNOWN, sem id) com motivo próprio e alerta; a recuperação automática não insiste nele.
 */
async function markRoutingConflict(submission, financingCase, transaction) {
  const { groupId, companyId, financingCaseId } = submission;
  submission.status = 'UNKNOWN';
  submission.externalCaseId = null;
  submission.failureReason = 'CONFLITO_ID_EXTERNO';
  await submission.save({ transaction });
  await recordIntegrationError(
    { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'submit', errorCode: 'EXTERNAL_CASE_ID_CONFLICT', message: 'O provider devolveu um identificador que já pertence a outro caso. Confira com o provider antes de reenviar.' },
    transaction
  );
  await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: 'Identificador externo já pertence a outro caso.', submissionId: `routing:${submission.id}` }, transaction);
}

/**
 * applyProviderOutcome — grava o resultado da chamada ao provider. Falha ambígua/timeout vira UNKNOWN (nunca
 * reenvio cego); recusa definitiva vira FAILED (pode ser refeito). Sucesso: marca a submissão como aceita e roda o
 * registro local num savepoint; se algo local falhar, a submissão continua aceita (com o id externo) e o worker
 * retoma só a parte local, sem chamar o provider de novo.
 */
async function applyProviderOutcome(adapter, submission, financingCase, outcome, actorUserId, transaction, { sendDocuments = true } = {}) {
  const { groupId, companyId, financingCaseId } = submission;
  if (outcome.error) {
    if (isDefinitiveProviderError(outcome.error)) {
      await markSubmissionFailed(submission, financingCase, outcome.error, transaction);
    } else {
      await markSubmissionUnknown(submission, financingCase, outcome.error, transaction);
    }
    return submission;
  }
  const { result } = outcome;
  if (!result || !validExternalId(result.externalId)) {
    // Resposta sem identificador do caso (ou com identificador inutilizável): não dá para vincular nem consultar
    // depois. Resultado incerto (nunca reenvio cego).
    await markSubmissionUnknown(submission, financingCase, new Error('O provider respondeu sem um identificador de caso válido.'), transaction);
    return submission;
  }
  let routingFailed = false;
  if (isDetachedCommits()) {
    try {
      await commitExternalRouting(financingCase, result.externalId);
    } catch (err) {
      if (err?.code === 'EXTERNAL_CASE_ID_CONFLICT') {
        await markRoutingConflict(submission, financingCase, transaction);
        return submission;
      }
      routingFailed = true;
    }
  }
  submission.status = 'SUBMITTED';
  submission.externalCaseId = result.externalId;
  submission.responseSnapshot = result;
  submission.failureReason = null;
  await submission.save({ transaction });
  try {
    if (routingFailed) throw new Error('roteamento não gravado');
    await sequelize.transaction({ transaction }, async (savepoint) => {
      await finalizeAcceptedSubmission(adapter, submission, financingCase, result, actorUserId, savepoint, { sendDocuments, origin: 'worker' });
    });
  } catch (err) {
    await financingCase.reload({ transaction });
    if (err?.code === 'EXTERNAL_CASE_ID_CONFLICT') {
      await markRoutingConflict(submission, financingCase, transaction);
      return submission;
    }
    submission.failureReason = 'FINALIZACAO_LOCAL_PENDENTE';
    await submission.save({ transaction });
    await recordIntegrationError(
      { groupId, companyId, financingCaseId, providerCode: financingCase.providerCode, operation: 'submit', errorCode: 'SUBMIT_FINALIZE_FAILED', message: 'O provider aceitou o caso, mas o sistema não conseguiu concluir o registro local. Nada será reenviado; o registro local será retomado.' },
      transaction
    );
    await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: 'O registro local do envio aceito será retomado.', submissionId: `finalize:${submission.id}` }, transaction);
  }
  return submission;
}

/**
 * processPendingSubmission — versão numa transação só (usada pelos testes e por chamadas diretas).
 * O worker de verdade usa os mesmos passos em três tempos (ver correspondentSubmissionWorkerJob):
 * marca "envio em andamento" e confirma, chama o provider FORA da transação e grava o resultado.
 */
async function processPendingSubmission(submission, financingCase, actorUserId, transaction) {
  const adapter = await preflightSubmission(submission, financingCase, actorUserId, transaction);
  if (!adapter) return submission;
  const timeoutMs = await getProviderTimeoutMs(submission.groupId, submission.companyId, transaction);
  const outcome = await callProviderSubmit(adapter, submission, timeoutMs);
  return applyProviderOutcome(adapter, submission, financingCase, outcome, actorUserId, transaction);
}

/**
 * acknowledgeUnknownSubmission — única forma de "destravar" uma nova tentativa depois de uma
 * submissão UNKNOWN, e só depois de CONSULTAR o provider (Caderno: "Timeout de envio gera
 * UNKNOWN/consulta antes de reenviar" e "Não reenviar após timeout sem consultar"):
 *  - com externalCaseId conhecido: consulta `getCaseStatus`; se o provider conhece o caso, a
 *    submissão é recuperada como enviada e NENHUM reenvio é liberado;
 *  - sem externalCaseId, em adapter que sabe procurar pela chave de idempotência
 *    (`findSubmissionByKey`): se o provider já tem o caso, recupera; se confirma que não tem,
 *    libera um novo envio;
 *  - provider sem API de consulta (workflow manual): exige que a pessoa descreva o que conferiu
 *    com o banco (`verification`), que fica na auditoria, e então libera.
 * Se a consulta falhar, nada é liberado: o caso continua aguardando.
 * Liberar = incrementar `submissionVersion`, que gera uma chave de idempotência nova no próximo envio.
 */
async function acknowledgeUnknownSubmission(submissionId, payload, actorUserId, groupId, companyId, transaction) {
  // 1) Leitura SEM trava e consulta ao provider: nenhuma linha fica travada enquanto se espera o provider.
  const preview = await ProviderSubmission.findOne({ where: { id: submissionId, groupId, companyId }, transaction });
  if (!preview) {
    throw AppError.notFound('Submissão não encontrada.', 'SUBMISSION_NOT_FOUND');
  }
  if (preview.status !== 'UNKNOWN') {
    throw AppError.badRequest('Só é possível reconhecer submissões com status "UNKNOWN".', 'SUBMISSION_NOT_UNKNOWN');
  }
  const previewCase = await getCaseOrThrow(preview.financingCaseId, groupId, companyId, transaction);
  assertCaseNotCanceled(previewCase);
  const adapter = resolveFinancingProviderAdapterByCode(previewCase.providerCode);
  if (!adapter) {
    throw AppError.internal(`Provider "${previewCase.providerCode}" configurado no caso não é suportado.`, 'SUBMISSION_PROVIDER_UNKNOWN');
  }
  const { action: eligibilityAction } = await resolveEligibilityConfig(groupId, companyId, transaction, actorUserId);
  const timeoutMs = providerTimeoutMs(eligibilityAction);

  const verification = String(payload?.verification || '').trim().slice(0, 500);
  const verificationMin = Number.isInteger(eligibilityAction.verificationMinLength) && eligibilityAction.verificationMinLength >= 1 ? eligibilityAction.verificationMinLength : 10;
  let found = null;
  try {
    if (preview.externalCaseId) {
      const status = await withTimeout(adapter.getCaseStatus(preview.externalCaseId), timeoutMs);
      found = { externalId: preview.externalCaseId, status: status?.rawProviderStatus || status?.status || 'SUBMITTED' };
    } else if (typeof adapter.findSubmissionByKey === 'function') {
      const lookup = await withTimeout(adapter.findSubmissionByKey(preview.idempotencyKey), timeoutMs);
      if (lookup?.found) {
        if (!validExternalId(lookup.externalId)) {
          throw AppError.unprocessable('O provider confirmou o caso, mas sem um identificador válido. Nada foi liberado: confira com o provider.', 'SUBMISSION_EXTERNAL_ID_INVALID');
        }
        found = { externalId: lookup.externalId, status: lookup.status || 'SUBMITTED' };
      }
    } else if (verification.length < verificationMin) {
      throw AppError.unprocessable(
        `Este provider não tem consulta automática. Descreva o que você conferiu com o banco (no mínimo ${verificationMin} caracteres) antes de liberar um novo envio.`,
        'SUBMISSION_VERIFICATION_REQUIRED'
      );
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.unprocessable(
      'Não foi possível consultar o provider agora. Nada foi liberado: tente novamente em instantes antes de reenviar.',
      'SUBMISSION_PROVIDER_QUERY_FAILED'
    );
  }

  // 2) Agora sim as travas, na ordem caso → submissão, e reconfirma o estado (pode ter mudado durante a consulta).
  await FinancingCase.findOne({ where: { id: preview.financingCaseId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  const submission = await ProviderSubmission.findOne({ where: { id: submissionId, groupId, companyId }, transaction, lock: transaction.LOCK.UPDATE });
  if (!submission || submission.status !== 'UNKNOWN') {
    throw AppError.conflict('Esta submissão mudou enquanto a consulta era feita. Atualize a tela e confira o estado atual.', 'SUBMISSION_CHANGED_DURING_QUERY');
  }
  const financingCase = await getCaseOrThrow(submission.financingCaseId, groupId, companyId, transaction);
  assertCaseNotCanceled(financingCase);

  if (found) {
    // Docs seguem logo depois do commit (fora desta trava): aqui só o registro local.
    await finalizeAcceptedSubmission(adapter, submission, financingCase, found, actorUserId, transaction, { sendDocuments: false, origin: 'manual_recovery' });
    await registrarAuditoria(
      {
        groupId,
        companyId,
        actorUserId,
        action: 'correspondent.submission.unknown_recovered',
        entityType: 'FinancingCase',
        entityId: financingCase.id,
        reason: `A consulta ao provider mostrou que o caso já estava registrado lá (referência "${found.externalId}", status "${found.status}"). A submissão ${submission.id} foi recuperada e nenhum reenvio foi liberado.`,
      },
      transaction
    );
    return { financingCase, acknowledgedSubmissionId: submission.id, recovered: true, externalCaseId: found.externalId };
  }

  // Não achou no provider: só libera depois de uma janela mínima desde o resultado incerto (dá tempo
  // de uma resposta tardia do provider chegar e evita criar o mesmo caso duas vezes). Um envio ainda "em andamento"
  // espera, no mínimo, o tempo máximo da chamada ao provider, mesmo que a espera configurada seja zero.
  const waitMinutes = Number.isInteger(eligibilityAction.unknownReleaseMinutes) ? eligibilityAction.unknownReleaseMinutes : 2;
  const sinceMs = Date.now() - new Date(submission.updatedAt ?? submission.updated_at ?? submission.createdAt).getTime();
  const minimumWaitMs = Math.max(waitMinutes * 60000, submission.failureReason === 'ENVIO_EM_ANDAMENTO' ? timeoutMs + 5000 : 0);
  if (sinceMs < minimumWaitMs) {
    const remaining = Math.max(1, Math.ceil((minimumWaitMs - sinceMs) / 60000));
    throw AppError.conflict(
      `O envio ainda pode estar em andamento no provider. Aguarde mais ${remaining} minuto(s) antes de liberar um novo envio (o tempo de espera é definido em Parâmetros).`,
      'SUBMISSION_UNKNOWN_TOO_RECENT'
    );
  }

  // A submissão incerta é encerrada (substituída): a tela deixa de tratá-la como pendência e permite o novo envio.
  submission.status = 'CANCELED';
  submission.failureReason = 'SUBSTITUIDA_POR_NOVO_ENVIO';
  await submission.save({ transaction });
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
      reason: `Status UNKNOWN da submissão ${submission.id} reconhecido depois de consultar o provider${verification ? ` (conferência informada: ${verification})` : ' (o provider não tem o caso)'} — a submissão foi encerrada e uma nova tentativa de envio agora é permitida.`,
    },
    transaction
  );

  return { financingCase, acknowledgedSubmissionId: submission.id, recovered: false };
}

/**
 * resendDocumentsToProvider — envia ao provider os documentos validados que ainda não foram (novas
 * versões, documentos do cliente depois de uma pendência, ou um envio que falhou). Só referência,
 * só do que é necessário, só para um caso já aceito pelo provider.
 */
async function resendDocumentsToProvider(financingCaseId, actorUserId, groupId, companyId, transaction) {
  const financingCase = await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  assertCaseNotCanceled(financingCase);
  const submission = await ProviderSubmission.findOne({
    where: { financingCaseId, groupId, companyId, status: 'SUBMITTED' },
    order: [['created_at', 'DESC']],
    transaction,
  });
  if (!submission || !submission.externalCaseId) {
    throw AppError.unprocessable('Este caso ainda não foi aceito pelo provider: não há para onde enviar os documentos.', 'SUBMISSION_NOT_ACCEPTED');
  }
  await assertEligible(financingCase, { skipAmount: true }, groupId, companyId, actorUserId, transaction);
  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter || !adapter.capabilities().uploadDocument) {
    throw AppError.unprocessable('O provider deste caso não recebe documentos pelo sistema.', 'SUBMISSION_UPLOAD_NOT_SUPPORTED');
  }
  let sent;
  if (isDetachedCommits()) {
    // Cada chamada ao provider roda sem a transação da requisição (que só leu): nada fica travado esperando o provider.
    sent = await sendNeededDocumentsDetached(detachedRunTx(groupId, companyId), financingCaseId, submission.id, actorUserId);
  } else {
    sent = await sendNeededDocuments(adapter, submission, financingCase, submission.externalCaseId, actorUserId, transaction);
  }
  return { sentCount: sent.length, sent };
}

/**
 * retryPendingFinalization — o provider já aceitou o caso, mas o registro local (status, histórico,
 * eventos, roteamento) falhou e a submissão ficou marcada `FINALIZACAO_LOCAL_PENDENTE`. O worker
 * retoma só a parte local, SEM chamar o provider de novo.
 */
async function retryPendingFinalization(submission, financingCase, actorUserId, transaction) {
  const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
  if (!adapter || !submission.externalCaseId) return false;
  try {
    if (isDetachedCommits()) await commitExternalRouting(financingCase, submission.externalCaseId);
    await sequelize.transaction({ transaction }, async (savepoint) => {
      await finalizeAcceptedSubmission(adapter, submission, financingCase, submission.responseSnapshot || { externalId: submission.externalCaseId, status: 'SUBMITTED' }, actorUserId, savepoint, { sendDocuments: false, origin: 'local_retry' });
    });
    return true;
  } catch (err) {
    if (err?.code === 'EXTERNAL_CASE_ID_CONFLICT') {
      await markRoutingConflict(submission, financingCase, transaction);
      return false;
    }
    // Uma segunda falha não repete para sempre: fica marcada e visível em Erros de integração.
    submission.failureReason = 'FINALIZACAO_LOCAL_FALHOU';
    await submission.save({ transaction });
    // O provider tem o caso: o caso local deixa de ficar parado em "pronto para envio" (entra na consulta de status).
    // Pelo caminho normal de mudança de status: com versão, histórico, evento e CRM, num savepoint.
    if (shouldApplyTransition(financingCase.status, 'SUBMITTED')) {
      try {
        await sequelize.transaction({ transaction }, async (savepoint) => {
          const beforeStatus = financingCase.status;
          financingCase.status = 'SUBMITTED';
          await financingCase.save({ transaction: savepoint });
          const history = await ProviderStatusHistory.create(
            { groupId: submission.groupId, companyId: submission.companyId, financingCaseId: financingCase.id, rawProviderStatus: 'SUBMITTED', normalizedStatus: 'SUBMITTED', source: 'submission', applied: true, occurredAt: new Date() },
            { transaction: savepoint }
          );
          await publishFinancingStatusChanged(financingCase, { previousStatus: beforeStatus, normalizedStatus: 'SUBMITTED', historyId: history.id }, savepoint);
          await syncOpportunityFromFinancingCase(financingCase, 'SUBMITTED', savepoint);
          await registrarAuditoria(
            { groupId: submission.groupId, companyId: submission.companyId, actorUserId, action: 'correspondent.financing_case.status_changed', entityType: 'FinancingCase', entityId: financingCase.id, beforeJson: { status: beforeStatus }, afterJson: { status: 'SUBMITTED' }, reason: 'O provider aceitou o caso, mas o registro local do envio falhou; o caso foi levado a "Enviado ao banco" para a consulta de status acompanhar.' },
            savepoint
          );
        });
      } catch (statusErr) {
        await financingCase.reload({ transaction });
        logger.warn({ financingCaseId: financingCase.id, err: sanitizeProviderMessage(statusErr?.message) }, 'Não foi possível levar o caso a "Enviado ao banco" depois da falha do registro local.');
      }
    }
    await recordIntegrationError(
      { groupId: submission.groupId, companyId: submission.companyId, financingCaseId: financingCase.id, providerCode: financingCase.providerCode, operation: 'submit', errorCode: 'SUBMIT_FINALIZE_RETRY_FAILED', message: 'O provider aceitou o caso, mas o registro local falhou de novo. Verifique o caso e o identificador externo.' },
      transaction
    );
    await publishIntegrationCorrespondentFailed(financingCase, { providerCode: financingCase.providerCode, reason: 'O registro local do envio aceito falhou de novo.', submissionId: `finalize-retry:${submission.id}` }, transaction);
    return false;
  }
}

// Documentos em envio neste processo: duas chamadas ao mesmo tempo (clique duplo) não enviam o mesmo documento duas vezes.
const uploadsInFlight = new Set();

/**
 * sendNeededDocumentsDetached — envia os documentos validados ao provider SEM segurar trava de caso
 * ou submissão durante as chamadas: lê (sem trava), chama o provider documento a documento e só
 * então grava a marca de enviado, cada passo numa transação curta (`runTx`). Usado pelo worker.
 * Devolve a lista dos documentos marcados como enviados.
 */
async function sendNeededDocumentsDetached(runTx, financingCaseId, submissionId, actorUserId = null) {
  const plan = await runTx(async (transaction) => {
    const submission = await ProviderSubmission.findByPk(submissionId, { transaction });
    const financingCase = submission && await FinancingCase.findByPk(financingCaseId, { transaction });
    if (!submission || !financingCase || !submission.externalCaseId) return null;
    const adapter = resolveFinancingProviderAdapterByCode(financingCase.providerCode);
    if (!adapter || !adapter.capabilities().uploadDocument) return null;
    const timeoutMs = await getProviderTimeoutMs(financingCase.groupId, financingCase.companyId, transaction);
    const requirements = await CaseRequirement.findAll({ where: { financingCaseId, required: true, status: 'VALIDATED' }, transaction });
    const items = [];
    for (const requirement of requirements) {
      // eslint-disable-next-line no-await-in-loop
      const document = await CaseDocument.findOne({ where: { requirementId: requirement.id, supersededAt: null }, transaction });
      if (document && !document.providerExternalDocumentId) items.push({ documentId: document.id, documentType: requirement.documentType, fileId: document.fileId, version: document.version });
    }
    return { providerCode: financingCase.providerCode, externalCaseId: submission.externalCaseId, idempotencyKey: submission.idempotencyKey, groupId: financingCase.groupId, companyId: financingCase.companyId, items, timeoutMs };
  });
  if (!plan || !plan.items.length) return [];
  const adapter = resolveFinancingProviderAdapterByCode(plan.providerCode);
  const sent = [];
  for (const item of plan.items) {
    if (uploadsInFlight.has(item.documentId)) continue;
    uploadsInFlight.add(item.documentId);
    try {
      let outcome;
      try {
        // eslint-disable-next-line no-await-in-loop
        outcome = { externalDocumentId: await uploadDocumentSafely(adapter, { idempotencyKey: `${plan.idempotencyKey}:doc:${item.documentId}`, externalCaseId: plan.externalCaseId, documentType: item.documentType, fileId: item.fileId, version: item.version }, plan.timeoutMs) };
      } catch (error) {
        outcome = { error };
      }
      const label = DOCUMENT_TYPE_LABELS[item.documentType] || item.documentType;
      // eslint-disable-next-line no-await-in-loop
      await runTx(async (transaction) => {
        const document = await CaseDocument.findByPk(item.documentId, { transaction, lock: transaction.LOCK.UPDATE });
        const financingCase = await FinancingCase.findByPk(financingCaseId, { transaction });
        if (!document || !financingCase) return;
        if (outcome.error) {
          const failure = documentFailureOf(outcome.error);
          await recordIntegrationError(
            { groupId: plan.groupId, companyId: plan.companyId, financingCaseId, providerCode: plan.providerCode, operation: 'upload_document', errorCode: failure.code, message: `${failure.reason} Documento: ${label}.` },
            transaction
          );
          await publishIntegrationCorrespondentFailed(financingCase, { providerCode: plan.providerCode, reason: failure.reason, submissionId: `doc:${item.documentId}:${Date.now()}` }, transaction);
          return;
        }
        // Reconfere depois da trava: a versão pode ter sido trocada ou já marcada como enviada por outra chamada.
        if (document.providerExternalDocumentId) return;
        if (document.supersededAt) {
          await registrarAuditoria(
            { groupId: plan.groupId, companyId: plan.companyId, actorUserId, action: 'correspondent.document.sent_superseded', entityType: 'CaseDocument', entityId: document.id, reason: `O documento "${label}" (versão ${item.version}) foi substituído enquanto era enviado ao provider; a versão vigente será enviada no próximo envio.` },
            transaction
          );
          return;
        }
        document.providerExternalDocumentId = outcome.externalDocumentId;
        document.sentToProviderAt = new Date();
        await document.save({ transaction });
        sent.push({ documentId: document.id, documentType: item.documentType });
        await registrarAuditoria(
          { groupId: plan.groupId, companyId: plan.companyId, actorUserId, action: 'correspondent.document.sent_to_provider', entityType: 'CaseDocument', entityId: document.id, reason: `Documento "${label}" (versão ${item.version}) enviado ao provider "${plan.providerCode}" junto ao caso ${plan.externalCaseId}. Só a referência foi enviada.` },
          transaction
        );
      });
    } finally {
      uploadsInFlight.delete(item.documentId);
    }
  }
  return sent;
}

async function listSubmissions(financingCaseId, groupId, companyId, transaction) {
  await getCaseOrThrow(financingCaseId, groupId, companyId, transaction);
  const rows = await ProviderSubmission.findAll({
    where: { financingCaseId, groupId, companyId },
    order: [['created_at', 'DESC']],
    transaction,
  });
  // O motivo da falha vai também em texto de tela (a tela não precisa conhecer os códigos internos).
  return rows.map((row) => ({ ...row.get({ plain: true }), failureReasonLabel: failureReasonLabel(row.failureReason) }));
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
  finalizeAcceptedSubmission,
  sendNeededDocumentsDetached,
  preflightSubmission,
  callProviderSubmit,
  applyProviderOutcome,
  retryPendingFinalization,
  resendDocumentsToProvider,
  sendNeededDocuments,
  requestSubmission,
  processPendingSubmission,
  submitFinancingCase,
  acknowledgeUnknownSubmission,
  listSubmissions,
  commitExternalRouting,
  markRoutingConflict,
  isDefinitiveProviderError,
  failureReasonLabel,
  isDetachedCommits,
  setDetachedCommitsForTest,
  detachedRunTx,
  stableStringify,
  withTimeout,
  SubmitTimeoutError,
};
