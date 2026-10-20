'use strict';

const { Op } = require('sequelize');
const { FinancialEntry, File, Person, ContractParty, PaymentIntent, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { assertBankAccountEligibleForPayment, assertNoDuplicatePayment, checkFrequentReversalAlert } = require('./financeAntifraud.service');
const { createAnomalyCase } = require('./anomalyCases.service');
const { publishFinancialEntryCreated, publishFinancialEntrySettled, publishFinancialEntryReversed, publishThirdPartyFundsReleased } = require('./financeEvents.service');
const { resolveAccountVersionForEntry } = require('./chartOfAccounts.service');
const periodClosuresService = require('./periodClosures.service');

const { assertPeriodOpenForEntry, isPeriodClosed } = periodClosuresService;

// C1 (coordenação com a frente "fechamento"): a guarda de COMPETÊNCIA (assertCompetenceOpen —
// bloqueia CLOSED e REVIEW, nos dois sentidos: entrar e sair do mês) é da frente de fechamento
// (periodClosures.service.js). Enquanto ela não estiver disponível, cai na guarda antiga por
// mês (assertPeriodOpenForEntry, que aceita "YYYY-MM" e bloqueia só CLOSED) — a chamada daqui
// já é a definitiva e não precisa mudar quando a guarda nova chegar.
function assertCompetenceOpen(companyId, competenceMonths, transaction) {
  if (typeof periodClosuresService.assertCompetenceOpen === 'function') {
    return periodClosuresService.assertCompetenceOpen(companyId, competenceMonths, transaction);
  }
  return assertPeriodOpenForEntry(companyId, [].concat(competenceMonths), transaction);
}
const { isApprovalRequestApproved, listApprovedDeciders, markApprovalRequestsStale } = require('./approvals.service');
const { getBankAccount } = require('./bankAccounts.service');

// finance.financial_entries É o ledger (não existe uma tabela "finance.ledger" separada — ver
// nota em financeAntifraud.service.js e o relatório de schema real). Regras duras
// (01_ARQUITETURA_E_INVARIANTES.md, FIN-003/FIN-010): "Ledger imutável... correção é sempre
// por estorno/lançamento compensatório" — por isso este service NUNCA dá UPDATE em `amount`
// de um lançamento já SETTLED, e `reverseEntry` cria um novo registro em vez de apagar/alterar
// o original.

const ENTRY_TYPES = ['DEBIT', 'CREDIT'];
// PENDING_CLASSIFICATION (auditoria externa 2026-10-07, contrato bruto, Centro Financeiro §10):
// "Valor excedente nunca é automaticamente tratado como receita; abre pendência de
// classificação." Natureza usada EXCLUSIVAMENTE para o lançamento-filho que representa o valor
// excedente de uma baixa parcial acima do saldo restante — nunca é RECEIVABLE/PAYABLE (não é
// receita/despesa própria até um humano classificar) e fica PENDING até alguém decidir o
// destino (ex.: reclassificar para RECEIVABLE de outro contrato, devolver, etc. — fora do
// escopo desta função, que só ABRE a pendência).
const NATURES = ['PAYABLE', 'RECEIVABLE', 'TRANSFER', 'ADJUSTMENT', 'PENDING_CLASSIFICATION'];
// PARTIALLY_SETTLED (M4-06): lançamento que já recebeu uma ou mais baixas parciais mas ainda
// tem saldo em aberto. Continua "vivo" (aceita novas baixas) até a soma fechar o total.
const STATUSES = ['PENDING', 'PARTIALLY_SETTLED', 'SETTLED', 'REVERSED', 'CANCELLED'];

// M4-03 — COMPETÊNCIA x VENCIMENTO.
// `competenceMonth` ("YYYY-MM") é o mês contábil a que o lançamento pertence e pode ser
// diferente do mês de vencimento (ex.: energia consumida em setembro que vence em outubro).
// REGRA DE DERIVAÇÃO (quando o campo não é informado):
//   1. se houver `dueAt`, usa o ano-mês do vencimento (em UTC);
//   2. senão, usa o ano-mês de "agora" (momento da criação do lançamento = created_at).
// Nunca derivamos de settledAt: competência é definida na origem da obrigação, não na baixa.
const COMPETENCE_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function toCompetenceMonth(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resolveCompetenceMonth(competenceMonth, dueAt) {
  if (competenceMonth !== undefined && competenceMonth !== null && competenceMonth !== '') {
    const normalized = String(competenceMonth).trim();
    if (!COMPETENCE_MONTH_REGEX.test(normalized)) {
      throw AppError.badRequest(
        'A competência precisa estar no formato mês/ano (ex.: 09/2026).',
        'FINANCE_ENTRY_VALIDATION'
      );
    }
    return normalized;
  }
  if (dueAt) return toCompetenceMonth(dueAt);
  return toCompetenceMonth(new Date());
}

function assertPositiveAmount(amount) {
  const numeric = Number(amount);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw AppError.badRequest('Informe um valor maior que zero.', 'FINANCE_ENTRY_VALIDATION');
  }
}

/**
 * assertNotUnderManualReview (M4-21) — fail closed: um lançamento flagado como anômalo pelo
 * antifraude não pode ser liquidado (total nem parcialmente) enquanto um humano não liberar
 * via `clearManualReview` (financeAntifraud.service.js).
 */
function assertNotUnderManualReview(entry) {
  if (entry.requiresManualReview) {
    throw AppError.conflict(
      'Este lançamento está retido para revisão manual (antifraude) e não pode ser liquidado até ser liberado por um revisor.',
      'FINANCE_ENTRY_REQUIRES_MANUAL_REVIEW'
    );
  }
}

// FIX AUD-2026-09-14 (reportado pela cliente: sistema aceitou vencimento no ano "92026"):
// nenhuma validação de faixa existia sobre `dueAt` — o campo DATE do Postgres aceita qualquer
// ano dentro do range do tipo, e nada no backend rejeitava um valor absurdo digitado por engano
// (typo de dígito extra) no front. Fail closed: vencimento precisa estar num intervalo humano
// plausível (100 anos atrás a 50 anos à frente), nunca um valor literalmente impossível.
// F03 (conferência Nayara 18/10/2026) — baixa direta versus confirmação bancária. Caderno
// Financeiro §8: "integração bancária retorna estado; sistema nunca presume sucesso;
// confirmação efetiva cria ledger". Um PAYABLE com conta bancária só vira SETTLED por um destes
// caminhos, e o caminho fica gravado no lançamento (settlementMethod):
//   BANK_CONFIRMED        confirmação efetiva do banco (bankPayments.confirmBankPayment, webhook
//                         ou polling do provider).
//   MANUAL_WITH_EVIDENCE  exceção formal para pagamento feito fora da integração (ex.: TED
//                         digitada no internet banking): exige comprovante (arquivo real já
//                         enviado), motivo, e a mesma aprovação prévia de outro usuário que o
//                         pagamento já exigia. Nunca é apresentado como confirmação bancária —
//                         a conciliação com o extrato continua sendo quem confirma o movimento.
// Antes desta correção, a baixa direta (rota /settle, /settle-partial e a execução manual de
// uma payment_intent) marcava SETTLED sem comprovante nenhum — presumia o sucesso.
//   SANDBOX_CONFIRMED     confirmação vinda do provedor SANDBOX (simulação): nunca é apresentada
//                         como confirmação de um banco real (revisão independente, B5).
//   COMPENSATION          saída de dinheiro de terceiro que abate dívida do próprio titular —
//                         não move caixa; exige aprovação de outro usuário (revisão, D3).
//
// REVISÃO INDEPENDENTE (18/10/2026, achados A1/A4):
//   A1 — a regra acima só valia para PAYABLE COM conta bancária: tirar a conta (PATCH com
//        bankAccountId null) ou criar o PAYABLE sem conta permitia liquidar sem aprovação, sem
//        comprovante e sem banco — e o lançamento contava como saída de caixa nos relatórios.
//        Agora TODA baixa de PAYABLE segue a regra: confirmação do banco, compensação aprovada,
//        ou baixa manual com comprovante e aprovação. E a conta de um PAYABLE não pode mais ser
//        removida (FINANCE_ENTRY_BANK_ACCOUNT_REMOVAL_FORBIDDEN).
//   A4 — o comprovante era informado só na hora da baixa: qualquer arquivo da empresa servia, o
//        mesmo arquivo podia pagar dois lançamentos e a aprovação era anterior ao comprovante
//        (ninguém aprovava a exceção vendo o arquivo). Agora o comprovante é ANEXADO ao
//        lançamento antes (attachSettlementEvidence): PDF ou imagem, de uso único (índice único +
//        checagem), o anexo invalida aprovações anteriores (STALE) e a aprovação tem de vir
//        depois, de OUTRA pessoa — que consegue abrir o arquivo, pois a coluna
//        settlement_evidence_file_id é mapeada para finance:read na regra de leitura de arquivos.
const SETTLEMENT_METHODS = {
  BANK_CONFIRMED: 'BANK_CONFIRMED',
  SANDBOX_CONFIRMED: 'SANDBOX_CONFIRMED',
  MANUAL_WITH_EVIDENCE: 'MANUAL_WITH_EVIDENCE',
  COMPENSATION: 'COMPENSATION',
};

const OPEN_PAYMENT_INTENT_STATUSES = ['PENDING', 'APPROVED', 'SUBMITTING', 'SUBMITTED'];
const SETTLEMENT_EVIDENCE_MIME_PREFIXES = ['application/pdf', 'image/'];

async function assertManualSettlementApprovedAfterEvidence(entry, transaction) {
  const deciders = await listApprovedDeciders('FinancialEntry', entry.id, transaction);
  if (deciders.length === 0) {
    throw AppError.conflict(
      'A baixa manual precisa ser aprovada por outra pessoa depois que o comprovante foi anexado — peça a aprovação deste lançamento.',
      'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL'
    );
  }
  if (entry.settlementEvidenceAttachedBy && deciders.every((d) => String(d) === String(entry.settlementEvidenceAttachedBy))) {
    throw AppError.forbidden(
      'Quem anexou o comprovante não pode ser quem aprovou a baixa manual (segregação de funções).',
      'FINANCE_SETTLEMENT_EVIDENCE_SELF_APPROVAL'
    );
  }
}

/**
 * resolvePayableSettlement — decide COMO um PAYABLE pode ser liquidado (ver comentário acima).
 * Retorna null para lançamentos que não são PAYABLE (recebimentos seguem o fluxo direto, §10).
 */
async function resolvePayableSettlement(entry, options, _transaction) {
  if (entry.nature !== 'PAYABLE') return null;
  const opts = options || {};
  if (opts.viaBankConfirmation) {
    return {
      method: opts.sandboxConfirmation ? SETTLEMENT_METHODS.SANDBOX_CONFIRMED : SETTLEMENT_METHODS.BANK_CONFIRMED,
      evidenceFileId: null,
      reason: null,
    };
  }
  if (opts.viaCompensation) {
    return { method: SETTLEMENT_METHODS.COMPENSATION, evidenceFileId: null, reason: opts.compensationReason || null };
  }

  const attachedFileId = entry.settlementEvidenceFileId ? String(entry.settlementEvidenceFileId) : null;
  const manual = opts.manualSettlement || null;
  const informedFileId = manual && manual.evidenceFileId ? String(manual.evidenceFileId) : null;
  if (!attachedFileId) {
    if (informedFileId) {
      throw AppError.conflict(
        'O comprovante precisa ser anexado ao lançamento ANTES da aprovação (quem aprova vê o arquivo). Anexe o comprovante, peça a aprovação e então dê a baixa.',
        'FINANCE_SETTLEMENT_EVIDENCE_NOT_ATTACHED'
      );
    }
    throw AppError.conflict(
      'Pagamento não pode ser dado como pago sem confirmação do banco. ' +
        'Se o pagamento já foi feito fora da integração bancária, anexe o comprovante e o motivo, peça a aprovação de outra pessoa e então dê a baixa manual.',
      'FINANCE_ENTRY_BANK_SETTLEMENT_REQUIRES_CONFIRMATION'
    );
  }
  if (informedFileId && informedFileId !== attachedFileId) {
    throw AppError.conflict(
      'O comprovante informado na baixa é diferente do comprovante anexado e aprovado para este lançamento.',
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_ATTACHED'
    );
  }
  return { method: SETTLEMENT_METHODS.MANUAL_WITH_EVIDENCE, evidenceFileId: attachedFileId, reason: entry.settlementReason };
}

function settlementAuditSuffix(settlementInfo) {
  if (!settlementInfo) return '';
  switch (settlementInfo.method) {
    case SETTLEMENT_METHODS.BANK_CONFIRMED:
      return ' Confirmado pelo banco.';
    case SETTLEMENT_METHODS.SANDBOX_CONFIRMED:
      return ' Confirmado pelo provedor SANDBOX (simulação) — não é confirmação de banco real.';
    case SETTLEMENT_METHODS.COMPENSATION:
      return ' Compensação com dívida do titular — sem movimento de caixa.';
    default:
      return ` Baixa manual com comprovante (arquivo ${settlementInfo.evidenceFileId}) — motivo: ${settlementInfo.reason}. Não é confirmação bancária.`;
  }
}

// A2 (revisão independente): a baixa direta/parcial era aceita com uma intenção de pagamento
// em aberto — inclusive já SUBMITTED ao banco. Depois o banco confirmava e a confirmação dava
// erro em loop (lançamento já liquidado), com risco de pagamento em dobro.
async function assertNoOpenPaymentIntent(entry, exceptIntentId, transaction) {
  const where = { financialEntryId: entry.id, status: OPEN_PAYMENT_INTENT_STATUSES };
  const open = await PaymentIntent.findOne({ where, transaction });
  if (open && String(open.id) !== String(exceptIntentId || '')) {
    throw AppError.conflict(
      `Este lançamento tem uma intenção de pagamento em aberto (status "${open.status}") — a baixa só pode acontecer por ela. ` +
        'Aguarde a resposta do banco ou cancele/resolva a intenção antes.',
      'FINANCE_ENTRY_HAS_OPEN_PAYMENT_INTENT',
      { paymentIntentId: open.id, paymentIntentStatus: open.status }
    );
  }
}

/**
 * attachSettlementEvidence — anexa o comprovante (e o motivo) de uma baixa manual ao PAYABLE,
 * ANTES da aprovação (A4). Invalida aprovações anteriores: a decisão precisa ser tomada vendo o
 * comprovante.
 */
async function attachSettlementEvidence(id, payload, actorUserId, transaction) {
  const { evidenceFileId, reason } = payload || {};
  const entry = await FinancialEntry.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (entry.nature !== 'PAYABLE') {
    throw AppError.conflict('Comprovante de baixa manual só se aplica a pagamento (PAYABLE).', 'FINANCE_SETTLEMENT_EVIDENCE_NOT_APPLICABLE');
  }
  if (!['PENDING', 'PARTIALLY_SETTLED'].includes(entry.status)) {
    throw AppError.conflict(`Lançamento com status "${entry.status}" não aceita comprovante de baixa.`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const normalizedReason = reason ? String(reason).trim() : '';
  if (!evidenceFileId || !normalizedReason) {
    throw AppError.badRequest('Informe o comprovante (arquivo) e o motivo da baixa manual.', 'FINANCE_SETTLEMENT_EVIDENCE_VALIDATION');
  }
  const evidence = await File.findOne({ where: { id: evidenceFileId, companyId: entry.companyId }, transaction });
  if (!evidence) {
    throw AppError.badRequest(
      'O comprovante informado não foi encontrado nesta empresa — envie o arquivo do comprovante antes.',
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_FOUND'
    );
  }
  const mime = String(evidence.mimeType || '').toLowerCase();
  if (!SETTLEMENT_EVIDENCE_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
    throw AppError.badRequest('O comprovante precisa ser PDF ou imagem.', 'FINANCE_SETTLEMENT_EVIDENCE_INVALID_TYPE');
  }
  // F2 (M45): o comprovante é único pelo CONTEÚDO (SHA-256), não só pelo fileId — o mesmo arquivo
  // enviado duas vezes gera dois File com o mesmo hash. Escopo: empresa do lançamento.
  let sameContentFileIds = [evidence.id];
  if (evidence.checksumSha256) {
    if (transaction) {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:k))', {
        replacements: { k: `settlement-evidence:${entry.companyId}:${evidence.checksumSha256}` },
        transaction,
      });
    }
    const twins = await File.findAll({
      attributes: ['id'],
      where: { companyId: entry.companyId, checksumSha256: evidence.checksumSha256 },
      transaction,
    });
    sameContentFileIds = Array.from(new Set([evidence.id, ...twins.map((f) => f.id)]));
  }
  const reused = await FinancialEntry.findOne({
    where: {
      settlementEvidenceFileId: { [Op.in]: sameContentFileIds },
      id: { [Op.ne]: entry.id },
      [Op.or]: [{ parentEntryId: null }, { parentEntryId: { [Op.ne]: entry.id } }],
    },
    transaction,
  });
  if (reused) {
    throw AppError.conflict(
      'Este comprovante já foi usado em outra baixa — cada baixa manual exige o próprio comprovante.',
      'FINANCE_SETTLEMENT_EVIDENCE_ALREADY_USED',
      { usedByEntryId: reused.id }
    );
  }

  const beforeJson = entry.toJSON();
  entry.settlementEvidenceFileId = evidence.id;
  entry.settlementReason = normalizedReason;
  entry.settlementEvidenceAttachedBy = actorUserId || null;
  entry.settlementEvidenceAttachedAt = new Date();
  entry.updatedBy = actorUserId || null;
  try {
    await entry.save({ transaction });
  } catch (err) {
    if (err && err.name === 'SequelizeUniqueConstraintError') {
      throw AppError.conflict(
        'Este comprovante já foi usado em outra baixa — cada baixa manual exige o próprio comprovante.',
        'FINANCE_SETTLEMENT_EVIDENCE_ALREADY_USED'
      );
    }
    throw err;
  }

  await markApprovalRequestsStale(
    'FinancialEntry',
    entry.id,
    'Comprovante de baixa manual anexado — a aprovação precisa ser feita sobre o comprovante.',
    actorUserId,
    transaction
  );

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settlement_evidence.attach',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Comprovante de baixa manual anexado (arquivo ${evidence.id}) — motivo: ${normalizedReason}.`,
    },
    transaction
  );
  return entry;
}

/**
 * detachSettlementEvidence — M45: remove o vínculo do comprovante de baixa manual de um
 * lançamento AINDA NÃO LIQUIDADO (PENDING). Usado para sanear vínculos que violam a regra de
 * comprovante único (ex.: mesmo arquivo/SHA-256 anexado a dois lançamentos antes da regra F2).
 * Não apaga nada do ledger: só limpa as colunas mutáveis do comprovante (o trigger de linha
 * também registra), invalida aprovações e grava auditoria de negócio com o motivo.
 */
async function detachSettlementEvidence(id, payload, actorUserId, transaction) {
  const reason = String((payload && payload.reason) || '').trim();
  if (reason.length < 5) {
    throw AppError.badRequest('Informe o motivo para remover o comprovante (mínimo de 5 caracteres).', 'FINANCE_SETTLEMENT_EVIDENCE_DETACH_REASON_REQUIRED');
  }
  const entry = await FinancialEntry.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (!entry.settlementEvidenceFileId) {
    throw AppError.conflict('Este lançamento não tem comprovante de baixa anexado.', 'FINANCE_SETTLEMENT_EVIDENCE_NOT_ATTACHED');
  }
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(
      'Só é possível remover o comprovante de um lançamento ainda não liquidado (em aberto).',
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  const beforeJson = entry.toJSON();
  const removedFileId = entry.settlementEvidenceFileId;
  entry.settlementEvidenceFileId = null;
  entry.settlementReason = null;
  entry.settlementEvidenceAttachedBy = null;
  entry.settlementEvidenceAttachedAt = null;
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });
  await markApprovalRequestsStale(
    'FinancialEntry',
    entry.id,
    'Comprovante de baixa manual removido — a aprovação precisa ser refeita sobre um novo comprovante.',
    actorUserId,
    transaction
  );
  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settlement_evidence.detach',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Comprovante de baixa manual removido (arquivo ${removedFileId}) — motivo: ${reason}.`,
    },
    transaction
  );
  return entry;
}

// D1/D3 (revisão independente): a liquidação de uma devolução/compensação de caução revalida o
// saldo da origem com lock (a validação só na criação deixava liquidar depois que a origem foi
// estornada, ou com saldo já consumido).
async function assertThirdPartyReleaseStillCovered(entry, transaction) {
  if (!(entry.nature === 'PAYABLE' && entry.isThirdPartyFunds && entry.thirdPartyOriginEntryId)) return;
  const origin = await FinancialEntry.findOne({
    where: { id: entry.thirdPartyOriginEntryId, companyId: entry.companyId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!origin || !['SETTLED', 'PARTIALLY_SETTLED'].includes(origin.status)) {
    throw AppError.conflict(
      'A caução de origem desta devolução não está mais recebida (foi estornada ou cancelada) — a devolução não pode ser paga.',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_RECEIVED'
    );
  }
  const balance = await computeThirdPartyOriginBalance(origin, transaction);
  if (toCents(balance.available) < 0) {
    throw AppError.conflict(
      `As saídas desta caução (${balance.released}) passam do valor recebido (${balance.received}).`,
      'FINANCE_THIRD_PARTY_RELEASE_EXCEEDS_BALANCE',
      { available: balance.available, received: balance.received, released: balance.released }
    );
  }
}

// F04 (conferência Nayara 18/10/2026) — rastreabilidade de caução / dinheiro de terceiros.
// Caderno Financeiro §13: "Movimentação exige vínculo com contrato e titular.
// Devolução/compensação cria evento e ledger próprio." Antes, uma devolução de caução era um
// PAYABLE solto: aceitava contrato diferente do recebimento, nenhum titular e qualquer valor.
// Agora toda SAÍDA de dinheiro de terceiro (PAYABLE com isThirdPartyFunds) aponta para o
// recebimento de origem e é validada contra ele: mesmo contrato, mesmo titular e valor até o
// saldo ainda não devolvido/compensado daquela origem.

async function receivedAmountCents(origin, transaction) {
  if (origin.status === 'SETTLED') return toCents(origin.amount);
  if (origin.status === 'PARTIALLY_SETTLED') {
    const children = await FinancialEntry.findAll({ where: { parentEntryId: origin.id, status: 'SETTLED' }, transaction });
    return children.reduce((acc, child) => acc + toCents(child.amount), 0);
  }
  return 0;
}

async function computeThirdPartyOriginBalance(originOrId, transaction) {
  const origin = typeof originOrId === 'string' ? await FinancialEntry.findByPk(originOrId, { transaction }) : originOrId;
  if (!origin) throw AppError.notFound('Recebimento de origem não encontrado.', 'FINANCE_THIRD_PARTY_ORIGIN_NOT_FOUND');
  const received = await receivedAmountCents(origin, transaction);
  const releases = await FinancialEntry.findAll({
    where: {
      thirdPartyOriginEntryId: origin.id,
      parentEntryId: null,
      status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] },
    },
    transaction,
  });
  const released = releases.reduce((acc, release) => acc + toCents(release.amount), 0);
  return {
    originEntryId: origin.id,
    contractId: origin.contractId,
    holderPersonId: origin.thirdPartyHolderPersonId,
    received: fromCents(received),
    released: fromCents(released),
    available: fromCents(received - released),
    releases: releases.map((release) => ({ id: release.id, amount: release.amount, status: release.status, description: release.description })),
  };
}

// D2 (revisão independente): o titular podia ser qualquer parte do contrato (o proprietário foi
// aceito como "dono" da caução). Caução/depósito de garantia é dinheiro de quem a entrega: o
// locatário/comprador ou o fiador — nunca o proprietário/vendedor.
const THIRD_PARTY_HOLDER_ROLES = ['TENANT', 'GUARANTOR', 'BUYER'];

async function assertThirdPartyHolderIsContractParty(holderPersonId, contractId, transaction) {
  const person = await Person.findByPk(holderPersonId, { transaction });
  if (!person) {
    throw AppError.badRequest('Titular do dinheiro de terceiro não encontrado.', 'FINANCE_THIRD_PARTY_HOLDER_NOT_FOUND');
  }
  const parties = await ContractParty.findAll({ where: { contractId, personId: holderPersonId }, transaction });
  if (parties.length === 0) {
    throw AppError.badRequest(
      'O titular informado não é parte do contrato — o dinheiro de terceiro precisa pertencer a uma parte do contrato.',
      'FINANCE_THIRD_PARTY_HOLDER_NOT_CONTRACT_PARTY'
    );
  }
  if (!parties.some((party) => THIRD_PARTY_HOLDER_ROLES.includes(party.partyRole))) {
    throw AppError.badRequest(
      `O titular da caução precisa ser locatário, comprador ou fiador do contrato (papel atual: ${parties.map((p) => p.partyRole).join(', ')}).`,
      'FINANCE_THIRD_PARTY_HOLDER_ROLE_INVALID'
    );
  }
}

// D3 (revisão independente): devolução (RETURN, sai dinheiro) e compensação (COMPENSATION, abate
// dívida do titular, sem caixa) eram indistinguíveis; a compensação não apontava a dívida.
const THIRD_PARTY_RELEASE_TYPES = ['RETURN', 'COMPENSATION'];

async function resolveCompensatedDebt({ companyId, compensatedEntryId, contractId, holderPersonId, amount }, transaction) {
  if (!compensatedEntryId) {
    throw AppError.badRequest(
      'Informe a dívida do titular que está sendo compensada com a caução.',
      'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_REQUIRED'
    );
  }
  const debt = await FinancialEntry.findOne({
    where: { id: compensatedEntryId, companyId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!debt) {
    throw AppError.notFound('Dívida a compensar não encontrada nesta empresa.', 'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_NOT_FOUND');
  }
  if (debt.nature !== 'RECEIVABLE' || debt.isThirdPartyFunds || !['PENDING', 'PARTIALLY_SETTLED'].includes(debt.status)) {
    throw AppError.conflict(
      'A dívida compensada precisa ser um valor a receber em aberto (não dinheiro de terceiro).',
      'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_INVALID'
    );
  }
  if (String(debt.contractId || '') !== String(contractId)) {
    throw AppError.conflict(
      'A dívida compensada é de outro contrato — a caução só compensa dívida do mesmo contrato.',
      'FINANCE_THIRD_PARTY_COMPENSATED_DEBT_CONTRACT_MISMATCH'
    );
  }
  const remaining = await computeRemainingAmount(debt, transaction);
  if (toCents(amount) > toCents(remaining)) {
    throw AppError.conflict(
      `A compensação (${fromCents(toCents(amount))}) passa do saldo em aberto da dívida (${remaining}).`,
      'FINANCE_THIRD_PARTY_COMPENSATION_EXCEEDS_DEBT'
    );
  }
  void holderPersonId;
  return debt;
}

async function resolveThirdPartyRelease({ companyId, contractId, holderPersonId, originEntryId, amount }, transaction) {
  if (!originEntryId) {
    throw AppError.badRequest(
      'Informe de qual recebimento de caução esta devolução ou compensação sai — é isso que liga a saída ao contrato e ao titular corretos.',
      'FINANCE_THIRD_PARTY_ORIGIN_REQUIRED'
    );
  }
  // Lock no recebimento de origem: duas devoluções simultâneas da mesma caução não podem ler o
  // mesmo saldo e, somadas, devolver mais do que foi recebido.
  const origin = await FinancialEntry.findOne({
    where: { id: originEntryId, companyId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!origin) {
    throw AppError.notFound('Recebimento de origem não encontrado nesta empresa.', 'FINANCE_THIRD_PARTY_ORIGIN_NOT_FOUND');
  }
  if (!origin.isThirdPartyFunds || origin.nature !== 'RECEIVABLE' || origin.parentEntryId) {
    throw AppError.conflict(
      'O lançamento de origem não é um recebimento de dinheiro de terceiro (caução).',
      'FINANCE_THIRD_PARTY_ORIGIN_INVALID'
    );
  }
  if (!['SETTLED', 'PARTIALLY_SETTLED'].includes(origin.status)) {
    throw AppError.conflict(
      'O recebimento de origem ainda não foi recebido — não há o que devolver ou compensar.',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_RECEIVED'
    );
  }
  if (!origin.contractId || !origin.thirdPartyHolderPersonId) {
    throw AppError.conflict(
      'O recebimento de origem não tem contrato e titular registrados — regularize o vínculo antes de devolver ou compensar.',
      'FINANCE_THIRD_PARTY_ORIGIN_UNTRACEABLE'
    );
  }
  if (contractId && String(contractId) !== String(origin.contractId)) {
    throw AppError.conflict(
      'O contrato da devolução/compensação é diferente do contrato em que a caução foi recebida.',
      'FINANCE_THIRD_PARTY_CONTRACT_MISMATCH'
    );
  }
  if (holderPersonId && String(holderPersonId) !== String(origin.thirdPartyHolderPersonId)) {
    throw AppError.conflict(
      'O titular da devolução/compensação é diferente do titular que entregou a caução.',
      'FINANCE_THIRD_PARTY_HOLDER_MISMATCH'
    );
  }
  const balance = await computeThirdPartyOriginBalance(origin, transaction);
  if (toCents(amount) > toCents(balance.available)) {
    throw AppError.conflict(
      `O valor (${fromCents(toCents(amount))}) é maior que o saldo ainda disponível da caução (${balance.available}).`,
      'FINANCE_THIRD_PARTY_RELEASE_EXCEEDS_BALANCE',
      { available: balance.available, received: balance.received, released: balance.released }
    );
  }
  return { origin, contractId: origin.contractId, holderPersonId: origin.thirdPartyHolderPersonId };
}

const DUE_DATE_MIN_YEAR = new Date().getUTCFullYear() - 100;
const DUE_DATE_MAX_YEAR = new Date().getUTCFullYear() + 50;

function assertReasonableDueDate(dueAt) {
  if (dueAt === undefined || dueAt === null || dueAt === '') return;
  const parsed = new Date(dueAt);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.badRequest('O vencimento informado não é uma data válida.', 'FINANCE_ENTRY_VALIDATION');
  }
  const year = parsed.getUTCFullYear();
  if (year < DUE_DATE_MIN_YEAR || year > DUE_DATE_MAX_YEAR) {
    throw AppError.badRequest(
      `O campo "dueAt" tem um ano fora do intervalo plausível (${DUE_DATE_MIN_YEAR} a ${DUE_DATE_MAX_YEAR}) — verifique se não há um dígito a mais ou a menos na data.`,
      'FINANCE_ENTRY_VALIDATION'
    );
  }
}

/**
 * createFinancialEntry — cria uma obrigação/direito (conta a pagar/receber) em status PENDING.
 * `idempotencyKey`, quando informada, impede duplicidade (ex.: reprocessar o mesmo import não
 * cria dois lançamentos — FIN-004).
 */
async function createFinancialEntry(payload, actorUserId, transaction, options = {}) {
  const {
    groupId,
    companyId,
    bankAccountId,
    costCenterId,
    resultCenterId,
    contractId,
    constructionProjectId,
    entryType,
    nature,
    amount,
    description,
    dueAt,
    competenceMonth,
    idempotencyKey,
    chartOfAccountId,
    isThirdPartyFunds,
    thirdPartyReference,
    thirdPartyOriginEntryId,
    thirdPartyHolderPersonId,
    thirdPartyReleaseType,
    thirdPartyCompensatedEntryId,
  } = payload;

  if (!groupId || !companyId || !entryType || !nature || amount === undefined || amount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "entryType", "nature" e "amount" são obrigatórios.',
      'FINANCE_ENTRY_VALIDATION'
    );
  }
  const normalizedType = String(entryType).toUpperCase();
  const normalizedNature = String(nature).toUpperCase();
  if (!ENTRY_TYPES.includes(normalizedType)) {
    throw AppError.badRequest(`O campo "entryType" deve ser um de: ${ENTRY_TYPES.join(', ')}.`, 'FINANCE_ENTRY_VALIDATION');
  }
  if (!NATURES.includes(normalizedNature)) {
    throw AppError.badRequest(`O campo "nature" deve ser um de: ${NATURES.join(', ')}.`, 'FINANCE_ENTRY_VALIDATION');
  }
  assertPositiveAmount(amount);
  assertReasonableDueDate(dueAt);
  const resolvedCompetenceMonth = resolveCompetenceMonth(competenceMonth, dueAt);

  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07; contrato, Centro Financeiro
  // BLINDADO v1, §4 "Plano de contas e dimensões"): "Centro de custo obrigatório para
  // despesa. Centro de resultado obrigatório para receita e análise de margem." A API aceitava
  // PAYABLE (despesa) sem costCenterId e RECEIVABLE (receita) sem resultCenterId. TRANSFER/
  // ADJUSTMENT/PENDING_CLASSIFICATION não são despesa nem receita própria (ver nota acima sobre
  // PENDING_CLASSIFICATION), por isso ficam de fora desta exigência.
  if (normalizedNature === 'PAYABLE' && !costCenterId) {
    throw AppError.badRequest(
      'Lançamento de despesa exige o centro de custo.',
      'FINANCE_ENTRY_COST_CENTER_REQUIRED'
    );
  }
  if (normalizedNature === 'RECEIVABLE' && !resultCenterId) {
    throw AppError.badRequest(
      'Lançamento de receita exige o centro de resultado.',
      'FINANCE_ENTRY_RESULT_CENTER_REQUIRED'
    );
  }

  // M4-16 — dinheiro de terceiro (caução, depósito de garantia, valores que só transitam pela
  // imobiliária) só pode ser marcado como tal se vier com a referência de a QUEM pertence.
  // Sem isso, a marcação seria uma flag solta: dá pra tirar o valor da receita própria, mas não
  // dá pra prestar contas de quem é o dinheiro — que é justamente a razão de segregar.
  const normalizedThirdParty = isThirdPartyFunds === true || isThirdPartyFunds === 'true';
  const normalizedThirdPartyReference =
    thirdPartyReference === undefined || thirdPartyReference === null ? null : String(thirdPartyReference).trim();
  if (normalizedThirdParty && !normalizedThirdPartyReference) {
    throw AppError.badRequest(
      'Lançamento de dinheiro de terceiro exige uma referência preenchida (ex.: "Caução contrato X") — é o que identifica de quem é o dinheiro.',
      'FINANCE_THIRD_PARTY_REFERENCE_REQUIRED'
    );
  }

  // F04 — vínculo de origem, contrato e titular do dinheiro de terceiro.
  if (thirdPartyOriginEntryId && !(normalizedThirdParty && normalizedNature === 'PAYABLE')) {
    throw AppError.badRequest(
      'O recebimento de origem só se aplica a devolução ou compensação de dinheiro de terceiro (despesa marcada como dinheiro de terceiro).',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_APPLICABLE'
    );
  }
  let resolvedContractId = contractId || null;
  let resolvedHolderPersonId = thirdPartyHolderPersonId || null;
  let thirdPartyRelease = null;
  let resolvedReleaseType = null;
  let compensatedDebt = null;
  if ((thirdPartyReleaseType || thirdPartyCompensatedEntryId) && !(normalizedThirdParty && normalizedNature === 'PAYABLE')) {
    throw AppError.badRequest(
      'O tipo de saída e a dívida compensada só se aplicam a devolução ou compensação de dinheiro de terceiro.',
      'FINANCE_THIRD_PARTY_ORIGIN_NOT_APPLICABLE'
    );
  }
  if (normalizedThirdParty && normalizedNature === 'PAYABLE' && options.ownerRepasseId) {
    // Repasse ao proprietário (19/10/2026): o dinheiro pago é do PROPRIETÁRIO (terceiro), não
    // despesa da empresa. Só o service de repasses passa `options.ownerRepasseId` (nunca vem do
    // body HTTP) — não há caução de origem: a origem é o próprio repasse aprovado.
    if (thirdPartyOriginEntryId || thirdPartyReleaseType || thirdPartyCompensatedEntryId) {
      throw AppError.badRequest('Pagamento de repasse não aceita vínculo de caução.', 'FINANCE_THIRD_PARTY_ORIGIN_NOT_APPLICABLE');
    }
    resolvedReleaseType = 'OWNER_REPASSE';
  } else if (normalizedThirdParty && normalizedNature === 'PAYABLE') {
    resolvedReleaseType = thirdPartyReleaseType ? String(thirdPartyReleaseType).toUpperCase() : 'RETURN';
    if (!THIRD_PARTY_RELEASE_TYPES.includes(resolvedReleaseType)) {
      throw AppError.badRequest(
        `O campo "thirdPartyReleaseType" deve ser um de: ${THIRD_PARTY_RELEASE_TYPES.join(', ')}.`,
        'FINANCE_ENTRY_VALIDATION'
      );
    }
    thirdPartyRelease = await resolveThirdPartyRelease(
      { companyId, contractId, holderPersonId: thirdPartyHolderPersonId, originEntryId: thirdPartyOriginEntryId, amount },
      transaction
    );
    resolvedContractId = thirdPartyRelease.contractId;
    resolvedHolderPersonId = thirdPartyRelease.holderPersonId;
    if (resolvedReleaseType === 'COMPENSATION') {
      if (bankAccountId) {
        throw AppError.badRequest(
          'Compensação não movimenta caixa — não informe conta bancária.',
          'FINANCE_THIRD_PARTY_COMPENSATION_NO_BANK_ACCOUNT'
        );
      }
      compensatedDebt = await resolveCompensatedDebt(
        { companyId, compensatedEntryId: thirdPartyCompensatedEntryId, contractId: resolvedContractId, holderPersonId: resolvedHolderPersonId, amount },
        transaction
      );
    } else if (thirdPartyCompensatedEntryId) {
      throw AppError.badRequest(
        'A dívida compensada só se aplica quando o tipo de saída é compensação.',
        'FINANCE_ENTRY_VALIDATION'
      );
    }
  } else if (normalizedThirdParty && normalizedNature === 'RECEIVABLE') {
    // D2 (revisão independente): recebimento de dinheiro de terceiro sem contrato e sem titular
    // era aceito e só travava na devolução. §13: toda movimentação exige vínculo.
    if (!resolvedContractId || !resolvedHolderPersonId) {
      throw AppError.badRequest(
        'Recebimento de caução exige o contrato e o titular. Informe os dois.',
        'FINANCE_THIRD_PARTY_LINK_REQUIRED'
      );
    }
    await assertThirdPartyHolderIsContractParty(resolvedHolderPersonId, resolvedContractId, transaction);
  } else if (normalizedThirdParty && resolvedHolderPersonId) {
    await assertThirdPartyHolderIsContractParty(resolvedHolderPersonId, resolvedContractId, transaction);
  } else if (!normalizedThirdParty && resolvedHolderPersonId) {
    throw AppError.badRequest(
      'O titular só se aplica a lançamento de dinheiro de terceiro.',
      'FINANCE_THIRD_PARTY_HOLDER_NOT_APPLICABLE'
    );
  }

  // §4 (Frente 3): a classificação gravada é a VERSÃO da conta vigente na data do fato
  // (`factDate` informado, senão o vencimento, senão agora) — não a conta "como está hoje".
  const chartVersion = await resolveAccountVersionForEntry(chartOfAccountId, companyId, payload.factDate || dueAt || new Date(), transaction);

  // FIX FIN-TS-004 (Caderno §20: "Empresa errada — conta BB Construção em despesa Locação —
  // Bloqueado"): até aqui, usar uma bankAccountId de OUTRA empresa (inclusive de outra empresa
  // do mesmo grupo, ex.: duas empresas da holding usando contas bancárias diferentes) só era
  // barrado pela RLS bruta do Postgres no INSERT — reproduzido ao vivo: "new row violates
  // row-level security policy for table \"financial_entries\"", um erro 500 sem nenhuma
  // mensagem de negócio. Na prática, a RLS de SELECT em bank_accounts já torna uma conta de
  // outra empresa invisível pra este getBankAccount (ele devolve FINANCE_BANK_ACCOUNT_NOT_FOUND,
  // não "achou mas é de outra empresa") — então o teste explícito de companyId abaixo é defesa
  // em profundidade (cobre um cenário só alcançável se a RLS de SELECT algum dia for
  // enfraquecida), mas o efeito prático já é: erro de negócio claro, nunca mais um 500 cru.
  if (bankAccountId) {
    const bankAccount = await getBankAccount(bankAccountId, transaction);
    if (bankAccount.companyId !== companyId) {
      throw AppError.badRequest(
        'A conta bancária informada pertence a outra empresa — um lançamento só pode usar uma conta bancária da mesma empresa (FIN-002, contas segregadas).',
        'FINANCE_ENTRY_BANK_ACCOUNT_COMPANY_MISMATCH'
      );
    }
  }

  // M4-19 — período fechado bloqueia lançamento novo naquele mês (competência do vencimento e
  // da própria criação). C1 (revisão independente): a COMPETÊNCIA informada também é conferida —
  // antes dava para criar um lançamento com vencimento futuro e competenceMonth de um mês já
  // fechado, mudando os números do fechamento depois do snapshot (Caderno §16).
  await assertPeriodOpenForEntry(companyId, [dueAt, new Date()], transaction);
  await assertCompetenceOpen(companyId, resolvedCompetenceMonth, transaction);

  await assertNoDuplicatePayment(FinancialEntry, idempotencyKey, transaction);

  const entry = await FinancialEntry.create(
    {
      groupId,
      companyId,
      bankAccountId: bankAccountId || null,
      costCenterId: costCenterId || null,
      resultCenterId: resultCenterId || null,
      contractId: resolvedContractId,
      // M6-97 — dimensão de origem Obras: só preenchida quando o lançamento nasce de uma
      // medição/obra (ver stageMeasurements.service.js), permite relatório de margem por obra.
      constructionProjectId: constructionProjectId || null,
      entryType: normalizedType,
      nature: normalizedNature,
      amount,
      description: description || null,
      dueAt: dueAt || null,
      competenceMonth: resolvedCompetenceMonth,
      settledAt: null,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      reversalOfEntryId: null,
      chartOfAccountId: chartOfAccountId || null,
      chartOfAccountVersionId: chartVersion ? chartVersion.id : null,
      isThirdPartyFunds: normalizedThirdParty,
      thirdPartyReference: normalizedThirdPartyReference,
      thirdPartyOriginEntryId: thirdPartyRelease ? thirdPartyRelease.origin.id : null,
      thirdPartyHolderPersonId: resolvedHolderPersonId,
      thirdPartyReleaseType: resolvedReleaseType,
      thirdPartyCompensatedEntryId: compensatedDebt ? compensatedDebt.id : null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  // D3 (revisão independente): o evento finance.third_party_funds.released era emitido na
  // CRIAÇÃO da devolução (ainda PENDING, nenhum dinheiro saiu). Agora sai na liquidação.
  await publishFinancialEntryCreated(entry, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.entry.create',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      afterJson: entry.toJSON(),
      reason: thirdPartyRelease
        ? `${resolvedReleaseType === 'COMPENSATION' ? `Compensação (abate da dívida ${compensatedDebt.id})` : 'Devolução'} de dinheiro de terceiro de ${amount} vinculada ao recebimento ${thirdPartyRelease.origin.id} (contrato ${thirdPartyRelease.contractId}, titular ${thirdPartyRelease.holderPersonId}).`
        : `Lançamento ${normalizedNature === 'PAYABLE' ? 'a pagar' : normalizedNature === 'RECEIVABLE' ? 'a receber' : normalizedNature.toLowerCase()} de ${amount} criado.`,
    },
    transaction
  );

  return entry;
}

/**
 * listFinancialEntries — filtros disponíveis: status, nature, bankAccountId, costCenterId,
 * chartOfAccountId (M4-01) e isThirdPartyFunds (M4-16).
 *
 * `isThirdPartyFunds` é um filtro de três estados de propósito: `true` devolve SÓ dinheiro de
 * terceiro, `false` devolve SÓ receita/despesa própria, e omitir devolve tudo. É isso que
 * permite somar "receita própria" sem nunca incluir caução — sem precisar que o chamador
 * lembre de filtrar em memória.
 */
async function listFinancialEntries(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.nature) where.nature = String(filters.nature).toUpperCase();
  if (filters.bankAccountId) where.bankAccountId = filters.bankAccountId;
  if (filters.costCenterId) where.costCenterId = filters.costCenterId;
  if (filters.chartOfAccountId) where.chartOfAccountId = filters.chartOfAccountId;
  if (filters.isThirdPartyFunds !== undefined && filters.isThirdPartyFunds !== null && filters.isThirdPartyFunds !== '') {
    where.isThirdPartyFunds = filters.isThirdPartyFunds === true || filters.isThirdPartyFunds === 'true';
  }
  if (filters.competenceMonth) where.competenceMonth = String(filters.competenceMonth).trim();
  return FinancialEntry.findAll({ where, order: [['due_at', 'ASC']], transaction });
}

async function getFinancialEntry(id, transaction) {
  const entry = await FinancialEntry.findByPk(id, { transaction });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  return entry;
}

/**
 * invalidateStaleOpenPaymentIntents — F-05. Depois de uma edição, toda intenção de pagamento ainda
 * não enviada ao banco (PENDING ou APPROVED) cujo retrato (snapshot) não bate mais com o
 * lançamento é cancelada, com motivo em português e auditoria antes/depois. Fica livre para uma
 * nova intenção sobre a versão atual. Intenção já enviada ao banco (SUBMITTING/SUBMITTED) não é
 * tocada aqui: a mudança de destino nesse estágio é barrada em updateFinancialEntry.
 */
async function invalidateStaleOpenPaymentIntents(entry, actorUserId, transaction) {
  const { buildEntrySnapshot, computeSnapshotHash } = require('./paymentIntents.service');
  const intents = await PaymentIntent.findAll({
    where: { financialEntryId: entry.id, status: ['PENDING', 'APPROVED'] },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (intents.length === 0) return 0;
  const currentHash = computeSnapshotHash(buildEntrySnapshot(entry));
  let invalidated = 0;
  for (const intent of intents) {
    if (intent.snapshotHash === currentHash) continue;
    const beforeJson = intent.toJSON();
    intent.status = 'CANCELLED';
    intent.cancelledAt = new Date();
    intent.cancelReason = 'Lançamento alterado após a aprovação: a intenção de pagamento foi invalidada. Crie uma nova intenção sobre a versão atual.';
    intent.updatedBy = actorUserId || null;
    await intent.save({ transaction });
    await registrarAuditoria(
      {
        groupId: intent.groupId,
        companyId: intent.companyId,
        actorUserId,
        action: 'finance.payment_intent.stale',
        entityType: 'PaymentIntent',
        entityId: intent.id,
        beforeJson,
        afterJson: intent.toJSON(),
        reason: intent.cancelReason,
      },
      transaction
    );
    invalidated += 1;
  }
  return invalidated;
}

/**
 * updateFinancialEntry — só permite editar campos "de agenda" (vencimento, centro de custo/
 * resultado, conta bancária) enquanto o lançamento estiver PENDING. Uma vez SETTLED/REVERSED,
 * o registro é histórico — qualquer correção de valor precisa passar por `reverseEntry`.
 */
async function updateFinancialEntry(id, payload, actorUserId, transaction) {
  const entry = await getFinancialEntry(id, transaction);
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(
      `Lançamento com status "${entry.status}" não pode mais ser editado — ledger imutável (FIN-003). Use estorno.`,
      'FINANCE_ENTRY_IMMUTABLE'
    );
  }
  const beforeJson = entry.toJSON();
  const { bankAccountId, costCenterId, resultCenterId, dueAt, description, chartOfAccountId, competenceMonth } = payload;
  if (dueAt !== undefined) assertReasonableDueDate(dueAt);

  // A1 (revisão independente, provado): remover a conta bancária de um PAYABLE e depois dar a
  // baixa contornava aprovação, comprovante e banco. A conta de um pagamento pode ser trocada
  // (redirecionamento, com revisão manual), nunca removida.
  if (entry.nature === 'PAYABLE' && entry.bankAccountId && bankAccountId === null) {
    throw AppError.conflict(
      'A conta bancária de um pagamento não pode ser removida — troque por outra conta (com revisão) ou cancele o lançamento.',
      'FINANCE_ENTRY_BANK_ACCOUNT_REMOVAL_FORBIDDEN'
    );
  }

  // M4-19 — não se edita lançamento cuja competência (vencimento atual, vencimento novo ou
  // criação) caia num mês já fechado. C1 (revisão independente, provado): a competência atual
  // e a nova também contam — antes dava para mover um lançamento PARA ou DE um mês fechado.
  const nextCompetenceMonth =
    competenceMonth !== undefined ? resolveCompetenceMonth(competenceMonth, dueAt !== undefined ? dueAt : entry.dueAt) : null;
  await assertPeriodOpenForEntry(
    entry.companyId,
    [entry.dueAt, dueAt !== undefined ? dueAt : null, entry.createdAt, entry.competenceMonth],
    transaction
  );
  if (nextCompetenceMonth && nextCompetenceMonth !== entry.competenceMonth) {
    await assertCompetenceOpen(entry.companyId, [entry.competenceMonth, nextCompetenceMonth], transaction);
  }

  if (chartOfAccountId !== undefined) {
    if (chartOfAccountId === null) {
      entry.chartOfAccountId = null;
      entry.chartOfAccountVersionId = null;
    } else {
      const chartVersion = await resolveAccountVersionForEntry(
        chartOfAccountId, entry.companyId, payload.factDate || payload.dueAt || entry.dueAt || entry.createdAt, transaction
      );
      entry.chartOfAccountId = chartOfAccountId;
      entry.chartOfAccountVersionId = chartVersion.id;
    }
  }
  if (competenceMonth !== undefined) {
    entry.competenceMonth = nextCompetenceMonth;
  }
  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-07, Marco 7/Procurement): trocar o
  // beneficiário (bankAccountId) de um lançamento PENDING não passava por nenhuma checagem
  // extra — dava pra redirecionar um payable pra uma conta diferente, já fora do cooldown
  // antifraude, e liquidar sem nenhum alerta. Troca de conta bancária é exatamente o padrão de
  // fraude que o módulo já defende em outro lugar (reabertura de cooldown quando os DADOS da
  // conta mudam — ver bankAccounts.service.js); aqui o "dado que muda" é qual conta o
  // lançamento aponta, não precisa reabrir cooldown da conta em si (ela pode já estar ACTIVE há
  // meses), mas precisa de revisão humana antes de poder ser liquidado.
  // FIX FIN-TS-004 — mesma checagem de createFinancialEntry: um redirecionamento de conta
  // bancária (troca de favorecido) nunca pode apontar pra uma conta de outra empresa.
  if (bankAccountId) {
    const bankAccount = await getBankAccount(bankAccountId, transaction);
    if (bankAccount.companyId !== entry.companyId) {
      throw AppError.badRequest(
        'A conta bancária informada pertence a outra empresa — um lançamento só pode usar uma conta bancária da mesma empresa (FIN-002, contas segregadas).',
        'FINANCE_ENTRY_BANK_ACCOUNT_COMPANY_MISMATCH'
      );
    }
  }

  if (bankAccountId !== undefined && bankAccountId !== entry.bankAccountId) {
    const inFlight = await PaymentIntent.count({ where: { financialEntryId: entry.id, status: ['SUBMITTING', 'SUBMITTED'] }, transaction });
    if (inFlight > 0) {
      throw AppError.conflict(
        'Há um pagamento em andamento no banco para este lançamento — não é possível trocar a conta do favorecido até o banco responder.',
        'FINANCE_ENTRY_HAS_OPEN_PAYMENT_INTENT'
      );
    }
  }

  const isBankAccountRedirect = bankAccountId !== undefined && entry.bankAccountId && bankAccountId && bankAccountId !== entry.bankAccountId;
  if (bankAccountId !== undefined) entry.bankAccountId = bankAccountId;
  if (costCenterId !== undefined) entry.costCenterId = costCenterId;
  if (resultCenterId !== undefined) entry.resultCenterId = resultCenterId;
  if (dueAt !== undefined) entry.dueAt = dueAt;
  if (description !== undefined) entry.description = description;
  entry.updatedBy = actorUserId || null;
  if (isBankAccountRedirect) {
    entry.requiresManualReview = true;
    entry.manualReviewReason = `Beneficiário alterado após a criação do lançamento (conta bancária redirecionada) — revisão manual obrigatória antes de liquidar.`;
    entry.manualReviewClearedAt = null;
    entry.manualReviewClearedBy = null;
  }
  await entry.save({ transaction });

  // F-05 (conferência ao vivo 20/10/2026, Caderno §9 e §17): trocar o favorecido ou qualquer
  // dado que entra no retrato (snapshot) da intenção de pagamento invalida a intenção que ainda
  // não foi ao banco — ela deixa de ficar "Aprovada" sobre um dado que mudou — e a troca de
  // conta abre um caso de revisão (alerta) além da marca de revisão manual.
  await invalidateStaleOpenPaymentIntents(entry, actorUserId, transaction);
  if (isBankAccountRedirect) {
    await createAnomalyCase(
      {
        groupId: entry.groupId,
        companyId: entry.companyId,
        caseType: 'BENEFICIARY_CHANGED',
        riskLevel: 'HIGH',
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: entry.id,
        reason: 'A conta bancária do favorecido foi trocada depois da criação do lançamento. As aprovações anteriores foram invalidadas e o pagamento exige revisão manual antes de ser liquidado.',
      },
      actorUserId,
      transaction
    );
  }

  // BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-18 — variante do A10): qualquer
  // edição do lançamento depois de uma aprovação invalida a aprovação (FIN-005 — a decisão foi
  // tomada sobre a versão anterior). As ApprovalRequests APPROVED viram STALE e a liquidação
  // volta a exigir uma rodada nova de revisão sobre a versão atual. Ver
  // approvals.service.js#markApprovalRequestsStale.
  await markApprovalRequestsStale(
    'FinancialEntry',
    entry.id,
    'Lançamento editado após a aprovação — decisão anterior invalidada (FIN-005, versão revisada obsoleta).',
    actorUserId,
    transaction
  );

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.update',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: 'Lançamento financeiro atualizado (agenda).',
    },
    transaction
  );

  return entry;
}

/**
 * settleFinancialEntry — baixa/liquida o lançamento (marca como pago/recebido). Se houver
 * `bankAccountId`, valida elegibilidade antifraude (cooldown/bloqueio) antes de liquidar.
 *
 * FIX FIN-004 (auditoria externa Abacus AI, 11/10/2026): esta função é chamada TANTO pelo
 * fluxo correto de pagamento (executePaymentIntent/confirmBankPayment, só depois de
 * payment_intent aprovado com snapshot/hash — Caderno §8) QUANTO diretamente pela rota HTTP
 * `POST /finance/entries/:id/settle`, que só exigia permissão + 2FA — sem NENHUMA checagem de
 * que um PAGAMENTO (nature PAYABLE) passou pela aprovação prévia obrigatória. A auditora
 * reproduziu isso ao vivo: "lançamento de teste não entrou na fila de aprovações; ação
 * 'Liquidar' apareceu direto no detalhe". `options.viaApprovedPaymentIntent` é passado como
 * `true` SÓ pelos dois chamadores internos legítimos (que só chegam aqui depois do
 * payment_intent ter sido aprovado/executado). Alternativamente, a liquidação direta é
 * liberada se já existir uma `ApprovalRequest` APPROVED para este FinancialEntry
 * (`approvals.service.js#isApprovalRequestApproved` — helper que já existia pronto pra isso,
 * mas nunca tinha sido chamado por nenhum outro service, como o próprio comentário dele
 * admitia: "uso opcional... este módulo não força nenhum outro service a exigir aprovação").
 * RECEIVABLE/TRANSFER/ADJUSTMENT não exigem isso: o Caderno (§10) descreve recebimento como
 * fluxo direto, sem aprovação prévia.
 */
async function assertIntentApprovedAfterEvidence(entry, intent) {
  if (!intent) return;
  if (!intent.approvedAt || !entry.settlementEvidenceAttachedAt || new Date(intent.approvedAt) <= new Date(entry.settlementEvidenceAttachedAt)) {
    throw AppError.conflict(
      'A intenção de pagamento foi aprovada antes de o comprovante ser anexado — a execução manual exige aprovação feita vendo o comprovante. Cancele e recrie a intenção depois de anexar.',
      'FINANCE_SETTLEMENT_EVIDENCE_NOT_REVIEWED'
    );
  }
  if (entry.settlementEvidenceAttachedBy && String(intent.approvedByUserId) === String(entry.settlementEvidenceAttachedBy)) {
    throw AppError.forbidden(
      'Quem anexou o comprovante não pode ser quem aprovou a intenção de pagamento (segregação de funções).',
      'FINANCE_SETTLEMENT_EVIDENCE_SELF_APPROVAL'
    );
  }
}

/**
 * runSettlementGates — todas as travas de uma baixa (integral ou parcial), na ordem:
 *   - confirmação do banco (viaBankConfirmation): é registro de um FATO já ocorrido. Não é
 *     recusada por controles de pré-pagamento (conta bloqueada/revisão manual depois do envio —
 *     B6) nem por período fechado (C1): nesses casos liquida no período corrente com referência
 *     ao original e abre caso de anomalia para o contador/revisor.
 *   - demais caminhos: revisão manual, intenção de pagamento em aberto (A2), aprovação prévia
 *     de PAYABLE (A1: com ou sem conta bancária), período aberto, elegibilidade da conta, e
 *     comprovante anexado + aprovação posterior de outra pessoa (A4).
 *   - devolução de caução: saldo da origem revalidado com lock (D1).
 */
async function runSettlementGates(entry, options, transaction) {
  const opts = options || {};
  const viaBankConfirmation = Boolean(opts.viaBankConfirmation);
  const viaCompensation = entry.nature === 'PAYABLE' && entry.thirdPartyReleaseType === 'COMPENSATION';
  const effectiveOptions = { ...opts, viaCompensation };
  const warnings = [];

  if (viaBankConfirmation) {
    if (entry.competenceMonth && (await isPeriodClosed(entry.companyId, entry.competenceMonth, transaction))) {
      warnings.push({
        caseType: 'POST_CLOSING_BANK_CONFIRMATION',
        reason: `Confirmação do banco chegou depois do fechamento de ${entry.competenceMonth} — liquidado no período corrente com referência ao período original (Caderno §16).`,
      });
    }
    if (entry.requiresManualReview) {
      warnings.push({
        caseType: 'BANK_CONFIRMATION_UNDER_REVIEW',
        reason: 'O banco confirmou um pagamento cujo lançamento estava retido para revisão manual — o pagamento já ocorreu; revisar.',
      });
    }
  } else {
    assertNotUnderManualReview(entry);
    await assertNoOpenPaymentIntent(entry, opts.paymentIntent ? opts.paymentIntent.id : null, transaction);
    if (entry.nature === 'PAYABLE' && !opts.viaApprovedPaymentIntent) {
      const hasApprovedRequest = await isApprovalRequestApproved('FinancialEntry', entry.id, transaction);
      if (!hasApprovedRequest) {
        throw AppError.conflict(
          'Pagamento (PAYABLE) não pode ser liquidado sem aprovação prévia — crie um payment_intent com snapshot/hash, ou uma ApprovalRequest aprovada para este lançamento, conforme o fluxo de pagamento do Caderno Técnico.',
          'FINANCE_ENTRY_PAYABLE_REQUIRES_PAYMENT_INTENT_APPROVAL'
        );
      }
    }
    // GAP REAL CORRIGIDO (auditoria externa Nayara, achado A02, 15/10/2026): período fechado.
    await assertPeriodOpenForEntry(entry.companyId, [entry.competenceMonth, new Date()], transaction);
    if (entry.bankAccountId && !viaCompensation) {
      await assertBankAccountEligibleForPayment(entry.bankAccountId, transaction);
    }
  }

  const settlementInfo = await resolvePayableSettlement(entry, effectiveOptions, transaction);
  if (settlementInfo && settlementInfo.method === SETTLEMENT_METHODS.MANUAL_WITH_EVIDENCE) {
    if (opts.viaApprovedPaymentIntent) {
      await assertIntentApprovedAfterEvidence(entry, opts.paymentIntent);
    } else {
      await assertManualSettlementApprovedAfterEvidence(entry, transaction);
    }
  }
  await assertThirdPartyReleaseStillCovered(entry, transaction);
  return { settlementInfo, warnings, viaCompensation };
}

async function recordSettlementWarnings(entry, warnings, actorUserId, transaction) {
  for (const warning of warnings) {
    await createAnomalyCase(
      {
        groupId: entry.groupId,
        companyId: entry.companyId,
        caseType: warning.caseType,
        riskLevel: 'MEDIUM',
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: entry.id,
        reason: warning.reason,
      },
      actorUserId,
      transaction
    );
  }
}

// D3: efeitos da liquidação de uma saída de dinheiro de terceiro — o evento sai quando o
// dinheiro sai (ou a dívida é abatida), e a compensação baixa a dívida do titular.
async function applyThirdPartySettlementEffects(entry, settledAmount, actorUserId, transaction) {
  if (!(entry.nature === 'PAYABLE' && entry.isThirdPartyFunds && entry.thirdPartyOriginEntryId)) return;
  if (entry.thirdPartyReleaseType === 'COMPENSATION' && entry.thirdPartyCompensatedEntryId) {
    await settleFinancialEntryPartial(entry.thirdPartyCompensatedEntryId, settledAmount, actorUserId, transaction, {
      viaCompensationOf: entry.id,
    });
  }
  await publishThirdPartyFundsReleased(entry, transaction);
}

async function settleFinancialEntry(id, actorUserId, transaction, options = {}) {
  // Lock pessimista: sem isto, duas chamadas concorrentes (ex.: executePaymentIntent chamado
  // duas vezes pra mesma intenção, ou dois cliques de "liquidar") liam PENDING nas duas antes
  // de qualquer uma commitar e ambas liquidavam.
  const entry = await FinancialEntry.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (entry.status === 'PARTIALLY_SETTLED') {
    throw AppError.conflict(
      'Este lançamento já tem baixas parciais — use a liquidação parcial do saldo restante (settleFinancialEntryPartial) para fechá-lo.',
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  if (entry.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível liquidar um lançamento PENDING (atual: "${entry.status}").`, 'FINANCE_ENTRY_INVALID_STATUS');
  }
  const { settlementInfo, warnings } = await runSettlementGates(entry, options, transaction);
  const beforeJson = entry.toJSON();

  entry.status = 'SETTLED';
  entry.settledAt = new Date();
  if (settlementInfo) {
    entry.settlementMethod = settlementInfo.method;
    entry.settlementEvidenceFileId = settlementInfo.evidenceFileId;
    entry.settlementReason = settlementInfo.reason;
  }
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });

  await publishFinancialEntrySettled(entry, transaction);
  await applyThirdPartySettlementEffects(entry, entry.amount, actorUserId, transaction);
  await recordSettlementWarnings(entry, warnings, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settle',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: entry.toJSON(),
      reason: `Lançamento de ${toBRLDisplay(entry.amount)} liquidado.${settlementAuditSuffix(settlementInfo)}${warnings.map((w) => ` ${w.reason}`).join('')}`,
    },
    transaction
  );

  return entry;
}

// --- M4-06: liquidação PARCIAL (recebimento/pagamento parcial no LEDGER) -------------------
//
// MODELAGEM (decisão documentada): o ledger é append-only e imutável — o `amount` do
// lançamento original NUNCA é alterado por uma baixa parcial. Cada baixa vira um NOVO
// lançamento SETTLED (mesmo entryType/nature/conta do pai) com o valor parcial, ligado ao
// original por `parentEntryId`. O ORIGINAL só muda de STATUS:
//   PENDING -> PARTIALLY_SETTLED (ainda há saldo) -> SETTLED (soma das baixas = amount).
// O saldo restante é CALCULADO (`computeRemainingAmount`), nunca armazenado — assim não existe
// a possibilidade de um "saldo materializado" divergir do que o ledger realmente diz.
//
// Toda a aritmética é feita em CENTAVOS inteiros: DECIMAL(18,2) em ponto flutuante daria
// erro de arredondamento (0.1 + 0.2 !== 0.3) e a exigência aqui é precisão até o centavo.

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function fromCents(cents) {
  return (cents / 100).toFixed(2);
}

// BUG GRAVE REAL CORRIGIDO (auditoria Marco 7 "reval", 2026-10-16): a `description` do
// lançamento de baixa parcial (visível em seletores de UI, ex.: baixa de parcela de seguro)
// embutia o valor cru ("60.00") e o UUID do lançamento original — jargão técnico vazando pro
// usuário final. `descriptionToBRL` formata em pt-BR; a description referencia o lançamento
// original pela SUA PRÓPRIA descrição de negócio, nunca pelo UUID.
function toBRLDisplay(decimalString) {
  return Number(decimalString).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * computeRemainingAmount — saldo em aberto do lançamento = amount - Σ(baixas parciais filhas
 * que estão SETTLED). Retorna string com 2 casas (mesma precisão do DECIMAL(18,2)).
 */
async function computeRemainingAmount(entryOrId, transaction) {
  const entry = typeof entryOrId === 'string' ? await getFinancialEntry(entryOrId, transaction) : entryOrId;
  const children = await FinancialEntry.findAll({
    where: { parentEntryId: entry.id, status: 'SETTLED' },
    transaction,
  });
  const settledCents = children.reduce((acc, child) => acc + toCents(child.amount), 0);
  return fromCents(toCents(entry.amount) - settledCents);
}

/**
 * settleFinancialEntryPartial — baixa parcial de `partialAmount` sobre o lançamento `id`.
 * Valida 0 < partialAmount <= saldo restante (tolerância zero, em centavos).
 */
async function settleFinancialEntryPartial(id, partialAmount, actorUserId, transaction, options = {}) {
  // Lock pessimista no pai: sem ele, duas baixas parciais concorrentes poderiam ler o mesmo
  // saldo restante e, somadas, ultrapassar o total do lançamento.
  const entry = await FinancialEntry.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!entry) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');

  if (!['PENDING', 'PARTIALLY_SETTLED'].includes(entry.status)) {
    throw AppError.conflict(
      `Só é possível liquidar parcialmente um lançamento PENDING ou PARTIALLY_SETTLED (atual: "${entry.status}").`,
      'FINANCE_ENTRY_INVALID_STATUS'
    );
  }
  // A01/A1/A2/A4/D1 — mesmas travas da baixa integral (runSettlementGates). Baixa parcial não é
  // caminho alternativo para contornar aprovação, comprovante, intenção em aberto ou período.
  if (entry.thirdPartyReleaseType === 'COMPENSATION') {
    throw AppError.conflict(
      'Compensação de caução é liquidada de uma vez (baixa integral), não em parcelas.',
      'FINANCE_THIRD_PARTY_COMPENSATION_PARTIAL_FORBIDDEN'
    );
  }
  assertPositiveAmount(partialAmount);
  const compensationOf = options && options.viaCompensationOf ? options.viaCompensationOf : null;
  const gates = compensationOf
    ? { settlementInfo: null, warnings: [] }
    : await runSettlementGates(entry, options, transaction);
  if (compensationOf) {
    // Baixa da DÍVIDA do titular abatida por uma compensação de caução já aprovada e liquidada
    // na mesma transação (applyThirdPartySettlementEffects) — período e lançamento conferidos.
    await assertPeriodOpenForEntry(entry.companyId, [entry.competenceMonth, new Date()], transaction);
  }
  const settlementInfo = compensationOf
    ? { method: SETTLEMENT_METHODS.COMPENSATION, evidenceFileId: null, reason: `Abatida por compensação de caução (lançamento ${compensationOf}).` }
    : gates.settlementInfo;

  const partialCents = toCents(partialAmount);
  const remainingCents = toCents(await computeRemainingAmount(entry, transaction));
  if (compensationOf && partialCents > remainingCents) {
    throw AppError.conflict('A compensação passa do saldo em aberto da dívida.', 'FINANCE_THIRD_PARTY_COMPENSATION_EXCEEDS_DEBT');
  }

  // FIX (auditoria externa 2026-10-07 — contrato bruto, Centro Financeiro §10 "Recebimentos e
  // parcelas"): recebimento é sempre ACEITO; o EXCEDENTE acima do saldo restante vira pendência
  // de classificação (nature=PENDING_CLASSIFICATION, status PENDING) — nunca receita automática.
  const appliedCents = Math.min(partialCents, remainingCents);
  const excessCents = partialCents - appliedCents;

  const beforeJson = entry.toJSON();

  const settlement = await FinancialEntry.create(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      bankAccountId: entry.bankAccountId,
      costCenterId: entry.costCenterId,
      resultCenterId: entry.resultCenterId,
      contractId: entry.contractId,
      entryType: entry.entryType,
      nature: entry.nature,
      amount: fromCents(appliedCents),
      description: `Baixa parcial de ${toBRLDisplay(fromCents(appliedCents))} — ${entry.description || 'lançamento financeiro'}`,
      dueAt: entry.dueAt,
      // A baixa parcial pertence à MESMA competência do lançamento original (a obrigação é a
      // mesma; o que mudou foi só o momento do caixa).
      competenceMonth: entry.competenceMonth,
      settledAt: new Date(),
      status: 'SETTLED',
      idempotencyKey: null,
      reversalOfEntryId: null,
      parentEntryId: entry.id,
      settlementMethod: settlementInfo ? settlementInfo.method : null,
      settlementEvidenceFileId: settlementInfo ? settlementInfo.evidenceFileId : null,
      settlementReason: settlementInfo ? settlementInfo.reason : null,
      // D3 (revisão independente, provado): a baixa parcial de uma caução nascia com
      // isThirdPartyFunds=false — relatórios que somam receita própria (isThirdPartyFunds:false)
      // passavam a contar caução como receita. A filha herda a marca e o vínculo do pai.
      isThirdPartyFunds: Boolean(entry.isThirdPartyFunds),
      thirdPartyReference: entry.thirdPartyReference || null,
      thirdPartyOriginEntryId: entry.thirdPartyOriginEntryId || null,
      thirdPartyHolderPersonId: entry.thirdPartyHolderPersonId || null,
      thirdPartyReleaseType: entry.thirdPartyReleaseType || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  let classificationPending = null;
  if (excessCents > 0) {
    classificationPending = await FinancialEntry.create(
      {
        groupId: entry.groupId,
        companyId: entry.companyId,
        bankAccountId: entry.bankAccountId,
        costCenterId: null,
        resultCenterId: null,
        contractId: entry.contractId,
        entryType: entry.entryType,
        nature: 'PENDING_CLASSIFICATION',
        amount: fromCents(excessCents),
        description:
          // Texto para o usuário (sem UUID): o vínculo com a origem fica em parentEntryId.
          `Valor recebido a mais (${formatBRLText(excessCents)}) em "${entry.description || 'lançamento'}" ` +
          '— aguardando classificação manual.',
        dueAt: null,
        competenceMonth: entry.competenceMonth,
        settledAt: null,
        status: 'PENDING',
        idempotencyKey: null,
        reversalOfEntryId: null,
        parentEntryId: entry.id,
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }

  const newRemainingCents = remainingCents - appliedCents;
  entry.status = newRemainingCents === 0 ? 'SETTLED' : 'PARTIALLY_SETTLED';
  if (newRemainingCents === 0) entry.settledAt = new Date();
  if (newRemainingCents === 0 && settlementInfo) {
    entry.settlementMethod = settlementInfo.method;
    entry.settlementEvidenceFileId = settlementInfo.evidenceFileId;
    entry.settlementReason = settlementInfo.reason;
  }
  entry.updatedBy = actorUserId || null;
  await entry.save({ transaction });

  await publishFinancialEntrySettled(settlement, transaction);
  if (entry.nature === 'PAYABLE' && entry.isThirdPartyFunds && entry.thirdPartyOriginEntryId) {
    await publishThirdPartyFundsReleased(settlement, transaction);
  }
  await recordSettlementWarnings(entry, gates.warnings, actorUserId, transaction);

  await registrarAuditoria(
    {
      groupId: entry.groupId,
      companyId: entry.companyId,
      actorUserId,
      action: 'finance.entry.settle_partial',
      entityType: 'FinancialEntry',
      entityId: entry.id,
      beforeJson,
      afterJson: {
        original: entry.toJSON(),
        settlementEntryId: settlement.id,
        appliedAmount: fromCents(appliedCents),
        remainingAmount: fromCents(newRemainingCents),
        excessAmount: excessCents > 0 ? fromCents(excessCents) : '0.00',
        classificationPendingEntryId: classificationPending ? classificationPending.id : null,
      },
      reason:
        excessCents > 0
          ? `Recebimento de ${fromCents(partialCents)} processado: ${fromCents(appliedCents)} baixou o ` +
            `lançamento de ${entry.amount} (saldo restante ${fromCents(newRemainingCents)}) e ${fromCents(excessCents)} ` +
            `excedente abriu pendência de classificação ${classificationPending.id} — nunca tratado como receita.`
          : `Baixa parcial de ${fromCents(appliedCents)} registrada no lançamento de ${entry.amount} ` +
            `(saldo restante ${fromCents(newRemainingCents)}).${settlementAuditSuffix(settlementInfo)}`,
    },
    transaction
  );

  return {
    original: entry,
    settlement,
    remainingAmount: fromCents(newRemainingCents),
    classificationPending,
  };
}

/**
 * listClassificationPendings — pendências de classificação abertas (M4-contrato §10):
 * lançamentos-filhos nature=PENDING_CLASSIFICATION ainda PENDING, agrupados pelo lançamento
 * original que gerou o excedente.
 */
async function listClassificationPendings(transaction, filters = {}) {
  const where = { nature: 'PENDING_CLASSIFICATION' };
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.parentEntryId) where.parentEntryId = filters.parentEntryId;
  const rows = await FinancialEntry.findAll({ where, order: [['created_at', 'DESC']], transaction });
  // Enriquecimento para a UI: data de abertura (createdAt) e dados do lançamento de origem
  // (descrição/valor) — o id da origem continua em parentEntryId, separado do texto.
  const parentIds = [...new Set(rows.map((r) => r.parentEntryId).filter(Boolean))];
  const parents = parentIds.length
    ? await FinancialEntry.findAll({ where: { id: parentIds }, attributes: ['id', 'description', 'amount', 'dueAt'], transaction })
    : [];
  const byId = new Map(parents.map((p) => [p.id, p]));
  return rows.map((r) => {
    const json = r.toJSON();
    const parent = byId.get(r.parentEntryId);
    return {
      ...json,
      createdAt: json.createdAt || json.created_at || null,
      parentEntry: parent ? { id: parent.id, description: parent.description, amount: parent.amount, dueAt: parent.dueAt } : null,
    };
  });
}

function formatBRLText(cents) {
  return (Number(cents) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * resolveClassificationPending — fecha a pendência: um humano decide a classificação final do
 * excedente, convertendo a nature para a definitiva (ex.: RECEIVABLE de outro contrato,
 * ADJUSTMENT, devolução). NUNCA automático (é exatamente o oposto do que o contrato proíbe).
 */
async function resolveClassificationPending(id, finalNature, actorUserId, transaction, options = {}) {
  const pending = await FinancialEntry.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!pending) throw AppError.notFound('Pendência de classificação não encontrada.', 'FINANCE_CLASSIFICATION_PENDING_NOT_FOUND');
  if (pending.nature !== 'PENDING_CLASSIFICATION') {
    throw AppError.conflict('Este lançamento não é uma pendência de classificação.', 'FINANCE_CLASSIFICATION_PENDING_INVALID');
  }
  if (pending.status !== 'PENDING') {
    throw AppError.conflict('Esta pendência já foi resolvida.', 'FINANCE_CLASSIFICATION_PENDING_ALREADY_RESOLVED');
  }
  const normalizedNature = String(finalNature || '').toUpperCase();
  if (!['RECEIVABLE', 'PAYABLE', 'ADJUSTMENT'].includes(normalizedNature)) {
    throw AppError.badRequest(
      'Escolha como classificar o valor excedente: receita, despesa ou ajuste.',
      'FINANCE_CLASSIFICATION_PENDING_VALIDATION'
    );
  }

  // A3 (revisão independente): transformava qualquer excedente em PAYABLE SETTLED com a conta
  // herdada — sem aprovação, sem comprovante, sem método de liquidação e sem conferir período.
  // Agora: o período da competência precisa estar aberto; RECEIVABLE/ADJUSTMENT apenas
  // classificam um dinheiro que JÁ entrou (fica SETTLED); PAYABLE vira uma OBRIGAÇÃO a pagar
  // (PENDING, com centro de custo) que segue o fluxo normal de pagamento (aprovação + banco ou
  // comprovante) — nunca uma saída de caixa automática.
  await assertPeriodOpenForEntry(pending.companyId, [pending.competenceMonth, new Date()], transaction);
  // C1: classificar muda os números da competência (o excedente passa a contar como receita,
  // despesa ou ajuste) — a competência precisa estar aberta (nem CLOSED nem em REVIEW).
  await assertCompetenceOpen(pending.companyId, pending.competenceMonth, transaction);
  const costCenterId = options && options.costCenterId ? options.costCenterId : null;
  if (normalizedNature === 'PAYABLE' && !costCenterId) {
    throw AppError.badRequest('Classificar como despesa exige o centro de custo.', 'FINANCE_ENTRY_COST_CENTER_REQUIRED');
  }
  const beforeJson = pending.toJSON();
  pending.nature = normalizedNature;
  if (normalizedNature === 'PAYABLE') {
    pending.costCenterId = costCenterId;
  } else {
    pending.status = 'SETTLED';
    pending.settledAt = new Date();
  }
  pending.updatedBy = actorUserId || null;
  await pending.save({ transaction });

  await registrarAuditoria(
    {
      groupId: pending.groupId,
      companyId: pending.companyId,
      actorUserId,
      action: 'finance.entry.classification_pending.resolve',
      entityType: 'FinancialEntry',
      entityId: pending.id,
      beforeJson,
      afterJson: pending.toJSON(),
      reason: `Pendência de classificação resolvida manualmente como ${normalizedNature}.`,
    },
    transaction
  );

  return pending;
}

/**
 * reverseEntry — ESTORNO. Nunca apaga nem edita o valor do lançamento original (FIN-010):
 * marca o original como REVERSED e cria um novo lançamento compensatório (`entryType`
 * invertido, mesmo `amount`) apontando de volta via `reversalOfEntryId`.
 */
async function reverseFinancialEntry(id, reasonText, actorUserId, transaction) {
  // Lock pessimista: mesmo padrão de settleFinancialEntry — duas chamadas concorrentes de
  // estorno pro mesmo lançamento não podem ambas ler status != REVERSED antes de qualquer uma
  // commitar (senão criam DOIS lançamentos compensatórios pro mesmo original).
  const original = await FinancialEntry.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!original) throw AppError.notFound('Lançamento financeiro não encontrado.', 'FINANCE_ENTRY_NOT_FOUND');
  if (original.status === 'REVERSED') {
    throw AppError.conflict('Este lançamento já foi estornado.', 'FINANCE_ENTRY_ALREADY_REVERSED');
  }
  if (original.status === 'CANCELLED') {
    throw AppError.conflict('Lançamento cancelado não pode ser estornado.', 'FINANCE_ENTRY_INVALID_STATUS');
  }

  // D1 (revisão independente, provado): estornar o recebimento de uma caução já devolvida
  // deixava o saldo da origem negativo. Com devolução/compensação ativa, estorne a saída antes.
  if (original.isThirdPartyFunds && original.nature === 'RECEIVABLE') {
    const activeRelease = await FinancialEntry.findOne({
      where: { thirdPartyOriginEntryId: original.id, parentEntryId: null, status: { [Op.notIn]: ['REVERSED', 'CANCELLED'] } },
      transaction,
    });
    if (activeRelease) {
      throw AppError.conflict(
        'Esta caução já tem devolução/compensação registrada — estorne a saída antes de estornar o recebimento.',
        'FINANCE_THIRD_PARTY_ORIGIN_HAS_RELEASES',
        { releaseEntryId: activeRelease.id }
      );
    }
  }

  // FIX (homologação 22/09/2026 — auditoria proativa): mesma lacuna de settleFinancialEntryPartial
  // — o estorno cria um NOVO FinancialEntry compensatório (status SETTLED) na mesma competência
  // do original, sem checar se esse mês já estava fechado.
  await assertPeriodOpenForEntry(original.companyId, [original.competenceMonth, new Date()], transaction);

  const beforeJson = original.toJSON();

  const compensatingType = original.entryType === 'DEBIT' ? 'CREDIT' : 'DEBIT';
  const reversal = await FinancialEntry.create(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      bankAccountId: original.bankAccountId,
      costCenterId: original.costCenterId,
      resultCenterId: original.resultCenterId,
      contractId: original.contractId,
      entryType: compensatingType,
      nature: 'ADJUSTMENT',
      amount: original.amount,
      dueAt: null,
      // O estorno pertence à mesma competência do lançamento estornado.
      competenceMonth: original.competenceMonth,
      settledAt: new Date(),
      status: 'SETTLED',
      idempotencyKey: null,
      reversalOfEntryId: original.id,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  original.status = 'REVERSED';
  original.updatedBy = actorUserId || null;
  await original.save({ transaction });

  await publishFinancialEntryReversed(original, reversal, transaction);

  await registrarAuditoria(
    {
      groupId: original.groupId,
      companyId: original.companyId,
      actorUserId,
      action: 'finance.entry.reverse',
      entityType: 'FinancialEntry',
      entityId: original.id,
      beforeJson,
      afterJson: { original: original.toJSON(), reversalEntryId: reversal.id },
      reason: reasonText ? `Lançamento estornado: ${reasonText}` : 'Lançamento estornado.',
    },
    transaction
  );

  // GAP REAL CORRIGIDO (Caderno §17, "Estorno frequente → Anomaly case"): checkFrequentReversalAlert
  // já calculava o sinal (N estornos na janela), mas nunca era chamada por nenhum fluxo real —
  // só por teste. Agora, a cada estorno, confere se a empresa cruzou o limiar e abre um caso de
  // anomalia (idempotente o bastante na prática: um caso por estorno que cruza o limiar; não é
  // um problema duplicar o alerta aqui, ao contrário de duplicar dinheiro).
  const reversalAlert = await checkFrequentReversalAlert(original.companyId, transaction);
  if (reversalAlert.flagged) {
    await createAnomalyCase(
      {
        groupId: original.groupId,
        companyId: original.companyId,
        caseType: 'FREQUENT_REVERSAL',
        riskLevel: 'HIGH',
        relatedEntityType: 'FinancialEntry',
        relatedEntityId: original.id,
        reason: `${reversalAlert.count} estornos nos últimos ${reversalAlert.windowDays} dias — acima do limiar configurado.`,
      },
      actorUserId,
      transaction
    );
  }

  return { original, reversal };
}

module.exports = {
  createFinancialEntry,
  listFinancialEntries,
  getFinancialEntry,
  updateFinancialEntry,
  settleFinancialEntry,
  settleFinancialEntryPartial,
  listClassificationPendings,
  resolveClassificationPending,
  computeRemainingAmount,
  resolveCompetenceMonth,
  reverseFinancialEntry,
  ENTRY_TYPES,
  NATURES,
  STATUSES,
  SETTLEMENT_METHODS,
  OPEN_PAYMENT_INTENT_STATUSES,
  computeThirdPartyOriginBalance,
  attachSettlementEvidence,
  detachSettlementEvidence,
};
