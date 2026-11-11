'use strict';

/**
 * Domínio da intenção de pagamento (Guia M4 §2 e §3; Caderno §8 e §9). Regra pura: estados, transições,
 * retrato (snapshot) dos campos que importam para pagar e o hash canônico desse retrato. Sem banco, sem HTTP.
 */
const crypto = require('node:crypto');

// SUBMITTED/FAILED fazem parte do ciclo de vida desde o adapter bancário (PROVIDER_BANCARIO.md,
// bank-submission.service.js) — faltavam aqui e qualquer validação futura que use STATUSES.includes()
// rejeitaria esses dois valores como inválidos.
// SUBMITTING (revisão independente, B1): estado gravado ANTES da chamada ao banco — se a
// resposta não chegar, a intenção fica incerta e só a reconciliação decide.
const STATUSES = ['PENDING', 'APPROVED', 'SUBMITTING', 'SUBMITTED', 'EXECUTED', 'FAILED', 'CANCELLED'];
const OPEN_STATUSES = ['PENDING', 'APPROVED', 'SUBMITTING', 'SUBMITTED'];
// Intenção ainda não enviada ao banco: é a que uma edição do lançamento invalida (F-05).
const NOT_SUBMITTED_STATUSES = ['PENDING', 'APPROVED'];
// Intenção já no banco (resposta incerta ou em trânsito).
const IN_FLIGHT_STATUSES = ['SUBMITTING', 'SUBMITTED'];
// SUBMITTED também é bloqueado no cancelamento: o pagamento já foi enviado ao banco (PROVIDER_BANCARIO.md),
// pode estar em processamento real naquele momento.
const NOT_CANCELLABLE_STATUSES = ['SUBMITTING', 'SUBMITTED', 'EXECUTED', 'CANCELLED'];

// M9-D237: o envio ao banco passa pelo Dispatch Service (finance/bank): HTTP 200/202 só envia (SUBMITTED), o status final assinado ou consultado confirma, e o valor confere em centavos.
// ERROR não é final (costuma ser transitório). RETURNED é tratado à parte (devolução depois de pago).
const FINAL_FAILURE_STATUSES = ['REJECTED', 'FAILED', 'CANCELLED', 'CANCELED', 'DENIED', 'EXPIRED'];
const RETURNED_STATUSES = ['RETURNED', 'REVERSED', 'REFUNDED'];

/** Transições do Guia §3 (preparar -> aprovar -> executar/enviar): de qual estado cada ato parte. */
const TRANSITIONS = Object.freeze({
  approve: 'PENDING',
  execute: 'APPROVED',
  submit: 'APPROVED',
  finalizeSubmission: 'SUBMITTING',
});

function canApprove(intent) {
  return intent.status === TRANSITIONS.approve;
}

function canExecute(intent) {
  return intent.status === TRANSITIONS.execute;
}

function canSubmitToBank(intent) {
  return intent.status === TRANSITIONS.submit;
}

function canCancel(intent) {
  return !NOT_CANCELLABLE_STATUSES.includes(intent.status);
}

function isInFlight(intent) {
  return IN_FLIGHT_STATUSES.includes(intent.status);
}

/** Maker-checker: quem criou a intenção não pode aprová-la. */
function isSelfApproval(intent, actorUserId) {
  return Boolean(intent.createdBy && actorUserId && intent.createdBy === actorUserId);
}

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

/**
 * buildEntrySnapshot — extrai do lançamento exatamente os campos que, se mudarem, mudam o
 * significado do pagamento. Campos puramente operacionais (updated_at, lock_version,
 * updated_by) ficam de fora de propósito: eles mudam por qualquer edição inócua e fariam o
 * hash divergir sem que nada de relevante para o dinheiro tivesse mudado.
 *
 * Valores são normalizados para string (DECIMAL vem do driver como string e de uma criação
 * recém-feita pode vir como number; datas viram ISO) para que o hash seja estável entre um
 * objeto recém-criado e o mesmo registro relido do banco.
 */
function buildEntrySnapshot(entry) {
  const asString = (value) => (value === null || value === undefined ? null : String(value));
  const asIso = (value) => (value ? new Date(value).toISOString() : null);
  return {
    financialEntryId: entry.id,
    groupId: entry.groupId,
    companyId: entry.companyId,
    bankAccountId: entry.bankAccountId || null,
    costCenterId: entry.costCenterId || null,
    resultCenterId: entry.resultCenterId || null,
    chartOfAccountId: entry.chartOfAccountId || null,
    contractId: entry.contractId || null,
    entryType: entry.entryType,
    nature: entry.nature,
    amount: asString(Number(entry.amount).toFixed(2)),
    description: entry.description || null,
    dueAt: asIso(entry.dueAt),
    status: entry.status,
    isThirdPartyFunds: Boolean(entry.isThirdPartyFunds),
    thirdPartyReference: entry.thirdPartyReference || null,
  };
}

/**
 * computeSnapshotHash — SHA-256 sobre uma serialização CANÔNICA (chaves ordenadas) do
 * snapshot. Mesmo padrão de computeContentHash em legal/contractVersions.service.js, com a
 * ordenação explícita porque aqui o objeto é montado programaticamente e a ordem das chaves
 * não pode ser a fonte da diferença entre dois hashes.
 */
function computeSnapshotHash(snapshot) {
  const canonical = JSON.stringify(
    Object.keys(snapshot)
      .sort()
      .reduce((acc, key) => {
        acc[key] = snapshot[key];
        return acc;
      }, {})
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Hash do retrato do estado ATUAL do lançamento. */
function currentEntryHash(entry) {
  return computeSnapshotHash(buildEntrySnapshot(entry));
}

/** Campos do retrato atual que divergem do retrato gravado na intenção. */
function changedSnapshotFields(currentSnapshot, recordedSnapshot) {
  return Object.keys(currentSnapshot).filter(
    (key) => JSON.stringify(currentSnapshot[key]) !== JSON.stringify(recordedSnapshot[key])
  );
}

/** §8.4: a chave de idempotência nasce na criação e o envio ao banco reaproveita a mesma. */
function idempotencyKeyFor(intentId) {
  return `payment-intent:${intentId}`;
}

module.exports = {
  STATUSES,
  OPEN_STATUSES,
  NOT_SUBMITTED_STATUSES,
  IN_FLIGHT_STATUSES,
  NOT_CANCELLABLE_STATUSES,
  FINAL_FAILURE_STATUSES,
  RETURNED_STATUSES,
  TRANSITIONS,
  canApprove,
  canExecute,
  canSubmitToBank,
  canCancel,
  isInFlight,
  isSelfApproval,
  normalizeStatus,
  buildEntrySnapshot,
  computeSnapshotHash,
  currentEntryHash,
  changedSnapshotFields,
  idempotencyKeyFor,
};
