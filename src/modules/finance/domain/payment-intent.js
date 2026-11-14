'use strict';

/**
 * Domínio da intenção de pagamento (Guia M4 §2, §3 e §4; Caderno §8 e §9). Regra pura: estados, transições, o retrato
 * aprovável (lançamento + valor/parcela + favorecido congelado) e o hash canônico desse retrato. Sem banco, sem HTTP.
 *
 * Estados do Guia §3 (DEC-056): DRAFT | PENDING_APPROVAL | APPROVED | EXECUTING | CONFIRMED | FAILED | CANCELED. A fase do envio
 * ao banco fica em `submission_phase` (NOT_STARTED, SUBMITTING, SUBMITTED, UNCERTAIN) enquanto a intenção está EXECUTING: as três
 * fases e a proteção contra pagamento em dobro continuam, sem estados fora do livro.
 */
const crypto = require('node:crypto');

const STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'CONFIRMED', 'FAILED', 'CANCELED'];
const SUBMISSION_PHASES = ['NOT_STARTED', 'SUBMITTING', 'SUBMITTED', 'UNCERTAIN'];
// Em aberto: impede uma segunda intenção para o mesmo lançamento (índice único parcial payment_intents_one_open_per_entry).
const OPEN_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING'];
// Ainda não foi ao banco: é a que uma edição do lançamento ou do favorecido invalida (Caderno §9).
const NOT_SUBMITTED_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];
// Já no banco (resposta incerta ou em trânsito).
const IN_FLIGHT_STATUSES = ['EXECUTING'];
// EXECUTING também não cancela: o pagamento pode estar em processamento real naquele momento.
const NOT_CANCELLABLE_STATUSES = ['EXECUTING', 'CONFIRMED', 'CANCELED'];

// M9-D237: status final do banco. ERROR não é final (costuma ser transitório). RETURNED é tratado à parte (devolução depois de pago).
const FINAL_FAILURE_STATUSES = ['REJECTED', 'FAILED', 'CANCELLED', 'CANCELED', 'DENIED', 'EXPIRED'];
const RETURNED_STATUSES = ['RETURNED', 'REVERSED', 'REFUNDED'];

/** Mapa dos estados antigos (antes da DEC-056) para os do Guia §3; usado pela migration de dados e pela leitura de linhas antigas. */
const LEGACY_STATUS_MAP = Object.freeze({
  PENDING: { status: 'PENDING_APPROVAL', submissionPhase: 'NOT_STARTED' },
  APPROVED: { status: 'APPROVED', submissionPhase: 'NOT_STARTED' },
  SUBMITTING: { status: 'EXECUTING', submissionPhase: 'SUBMITTING' },
  SUBMITTED: { status: 'EXECUTING', submissionPhase: 'SUBMITTED' },
  EXECUTED: { status: 'CONFIRMED', submissionPhase: null },
  FAILED: { status: 'FAILED', submissionPhase: null },
  CANCELLED: { status: 'CANCELED', submissionPhase: null },
});

/** Transições do Guia §3 (preparar -> aprovar -> executar/enviar): de qual estado cada ato parte. */
const TRANSITIONS = Object.freeze({
  approve: 'PENDING_APPROVAL',
  execute: 'APPROVED',
  submit: 'APPROVED',
});

// Versão do retrato: 2 = retrato do Guia §3/§4 (lançamento + valor/parcela + favorecido). Retrato sem versão é anterior à regra e
// não cobre o favorecido: não serve mais para aprovar, enviar ou executar (a intenção precisa ser refeita).
const SNAPSHOT_VERSION = 2;

const canApprove = (intent) => intent.status === TRANSITIONS.approve;
const canExecute = (intent) => intent.status === TRANSITIONS.execute;
const canSubmitToBank = (intent) => intent.status === TRANSITIONS.submit;
const canCancel = (intent) => !NOT_CANCELLABLE_STATUSES.includes(intent.status);
const isInFlight = (intent) => IN_FLIGHT_STATUSES.includes(intent.status);
/** Fase 1 gravada e sem resposta conclusiva do banco (antes "SUBMITTING"). */
const isAwaitingSubmission = (intent) => intent.status === 'EXECUTING' && ['SUBMITTING', 'UNCERTAIN'].includes(intent.submissionPhase);
/** O banco aceitou a ordem e falta o status final (antes "SUBMITTED"). */
const isSubmitted = (intent) => intent.status === 'EXECUTING' && intent.submissionPhase === 'SUBMITTED';
const isLegacySnapshot = (intent) => !intent.snapshotJson || Number(intent.snapshotJson.snapshotVersion) !== SNAPSHOT_VERSION;

/** Maker-checker: quem criou a intenção não pode aprová-la. */
function isSelfApproval(intent, actorUserId) {
  return Boolean(intent.createdBy && actorUserId && intent.createdBy === actorUserId);
}

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

/** Guia §4 assertPayable: só lançamento a PAGAR (natureza PAYABLE, saída de caixa) vira intenção de pagamento. */
function isPayable(entry) {
  return Boolean(entry) && entry.nature === 'PAYABLE' && entry.entryType === 'DEBIT';
}

/**
 * buildEntrySnapshot — campos do lançamento que, se mudarem, mudam o significado do pagamento. Campos operacionais
 * (updated_at, lock_version, updated_by) ficam de fora de propósito. Valores em string para o hash ser estável.
 */
function buildEntrySnapshot(entry) {
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
    amount: centsText(entry.amount),
    description: entry.description || null,
    dueAt: asIso(entry.dueAt),
    status: entry.status,
    isThirdPartyFunds: Boolean(entry.isThirdPartyFunds),
    thirdPartyReference: entry.thirdPartyReference || null,
  };
}

/** Valor monetário como texto com 2 casas, a partir de centavos inteiros (sem ponto flutuante). */
function centsText(value) {
  const cents = toCents(value);
  if (cents === null) return null;
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Centavos inteiros de um decimal com até 2 casas ("1250.5", 1250.5, "1250,50"); null se não for um decimal limpo e não negativo. */
function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
}

/**
 * buildBeneficiarySnapshot — Guia §3 beneficiarySnapshot {personId, name, bankCode, branch, account, pixKey}: o favorecido
 * congelado no PREPARE (Caderno §9). Sem conta de destino, só o nome (pagamento por baixa manual com comprovante).
 */
function buildBeneficiarySnapshot(bankAccount, ownerPerson, fallbackName) {
  if (!bankAccount) {
    return { bankAccountId: null, personId: null, name: fallbackName || null, bankCode: null, branch: null, account: null, pixKey: null };
  }
  return {
    bankAccountId: bankAccount.id,
    personId: bankAccount.ownerPersonId || null,
    name: (ownerPerson && ownerPerson.legalName) || fallbackName || null,
    bankCode: bankAccount.bankCode || null,
    branch: bankAccount.agency || null,
    account: bankAccount.accountNumber || null,
    pixKey: bankAccount.pixKey || null,
  };
}

/**
 * buildApprovableSnapshot — Guia §4 `intent.approvableSnapshot`: o lançamento, o valor desta intenção (parcela/valor escolhido
 * no PREPARE, Caderno §8.2), o número da parcela e o favorecido congelado. `amount` é o valor que vai ao banco.
 */
function buildApprovableSnapshot(entry, { amountCents, installmentNumber, beneficiary }) {
  const amount = `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, '0')}`;
  const entrySnapshot = buildEntrySnapshot(entry);
  return {
    snapshotVersion: SNAPSHOT_VERSION,
    ...entrySnapshot,
    entryAmount: entrySnapshot.amount,
    amount,
    installmentNumber,
    beneficiary: { ...beneficiary },
  };
}

/** SHA-256 sobre a serialização canônica (chaves ordenadas em todos os níveis) do retrato. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function computeSnapshotHash(snapshot) {
  return crypto.createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/** Campos do retrato atual que divergem do retrato gravado na intenção (o favorecido é comparado campo a campo). */
function changedSnapshotFields(currentSnapshot, recordedSnapshot) {
  const recorded = recordedSnapshot || {};
  const keys = new Set([...Object.keys(currentSnapshot), ...Object.keys(recorded)]);
  const changed = [];
  for (const key of keys) {
    if (key === 'beneficiary') {
      const a = currentSnapshot.beneficiary || {};
      const b = recorded.beneficiary || {};
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) changed.push(`beneficiary.${f}`);
      }
    } else if (JSON.stringify(currentSnapshot[key] ?? null) !== JSON.stringify(recorded[key] ?? null)) {
      changed.push(key);
    }
  }
  return changed;
}

/** §8.4: a chave de idempotência nasce na criação e o envio ao banco reaproveita a mesma. */
function idempotencyKeyFor(intentId) {
  return `payment-intent:${intentId}`;
}

module.exports = {
  STATUSES,
  SUBMISSION_PHASES,
  OPEN_STATUSES,
  NOT_SUBMITTED_STATUSES,
  IN_FLIGHT_STATUSES,
  NOT_CANCELLABLE_STATUSES,
  FINAL_FAILURE_STATUSES,
  RETURNED_STATUSES,
  LEGACY_STATUS_MAP,
  TRANSITIONS,
  SNAPSHOT_VERSION,
  canApprove,
  canExecute,
  canSubmitToBank,
  canCancel,
  isInFlight,
  isAwaitingSubmission,
  isSubmitted,
  isLegacySnapshot,
  isSelfApproval,
  isPayable,
  normalizeStatus,
  toCents,
  centsText,
  buildEntrySnapshot,
  buildBeneficiarySnapshot,
  buildApprovableSnapshot,
  canonicalJson,
  computeSnapshotHash,
  changedSnapshotFields,
  idempotencyKeyFor,
};
