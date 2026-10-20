'use strict';

const { Op } = require('sequelize');
const { OwnerRepass, FinancialEntry, AuditLog, Contract, Person } = require('../../models');
const { formatCompetenceBR, formatMoneyBR } = require('../../utils/formatBR');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { assertBankAccountEligibleForPayment, assertNoDuplicatePayment } = require('./financeAntifraud.service');
const { publishOwnerRepasseCreated, publishOwnerRepassCompleted } = require('./financeEvents.service');

// Carregado sob demanda: financialEntries.service importa módulos que importam este arquivo.
function entriesService() {
  // eslint-disable-next-line global-require
  return require('./financialEntries.service');
}

const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'CANCELLED'];

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// --- M4-contrato §12 "Repasses de proprietários" --------------------------------------------
//
// Auditoria externa (contrato bruto, 2026-10-07): "Valor recebido do locatário é decomposto em
// componentes: aluguel, taxa, multa, consumo, manutenção, comissão/administração etc.",
// "owner_repass calcula valor devido ao proprietário por contrato/regra.", "Repasse não pode
// ser maior que valor elegível recebido, salvo ajuste formal." e "Extrato do proprietário
// mostra composição, não apenas valor líquido." O código ANTERIOR aceitava `grossAmount`
// digitado livremente, sem nenhum vínculo com recebimento real — violação literal da regra de
// teto. Agora `createOwnerRepasse` exige `sourceEntryIds` (lançamentos de recebimento REAIS,
// SETTLED, RECEIVABLE) e recalcula o teto elegível a partir deles; `grossAmount` nunca mais é
// aceito como valor livre.
//
// "salvo ajuste formal" é modelado como `formalAdjustment: { amount, reason, approvedBy }` —
// sem isso, exceder o teto é SEMPRE bloqueado (fail closed).
//
// MODELAGEM (sem migration disponível nesta rodada — ver nota de infraestrutura no relatório
// final; DDL indisponível para `nayara_runtime` no banco remoto no momento desta
// implementação): a COMPOSIÇÃO (quais lançamentos formaram o valor elegível) é registrada no
// `afterJson` do próprio registro de auditoria append-only (`audit.audit_log`, já existente,
// já imutável/INSERT-only) em vez de uma tabela nova dedicada — mesmo princípio de "não inventar
// tabela nova quando o fato cabe no rastro de auditoria já obrigatório" usado no restante do
// módulo (ex.: finance.financial_entries fazendo às vezes de "ledger" — ver nota em
// financeAntifraud.service.js). `getOwnerRepasseComposition` abaixo consulta esse rastro.

// GAP REAL CORRIGIDO (auditoria externa Nayara, 15/10/2026, Seção 4 "Marco 4 — Financeiro",
// grupo "Repasses e composição §12": "dois repasses não reutilizam o mesmo saldo"): o teto
// elegível era recalculado do zero a cada chamada a partir do `amount` do lançamento-fonte,
// sem nunca checar quanto desse mesmo lançamento já tinha sido usado por um repasse ANTERIOR.
// Dois repasses distintos apontando para o mesmo `sourceEntryIds` passavam os dois, cada um
// usando o valor cheio do recebimento como teto — dinheiro sendo "repassado" duas vezes a
// partir do mesmo recebimento real. `getAlreadyAllocatedAmount` soma, por lançamento-fonte,
// quanto já foi alocado por repasses anteriores NÃO cancelados (lidos do mesmo rastro de
// auditoria append-only usado por `getOwnerRepasseComposition` — não há tabela de junção
// dedicada nesta rodada, ver nota de modelagem acima) e deduz esse valor do teto disponível.
async function getAlreadyAllocatedAmount(entryId, transaction) {
  const logs = await AuditLog.findAll({
    where: { action: 'finance.owner_repasse.create', entityType: 'OwnerRepass' },
    transaction,
  });
  let allocatedCents = 0;
  for (const log of logs) {
    const afterJson = log.afterJson || {};
    const composition = Array.isArray(afterJson.composition) ? afterJson.composition : [];
    const match = composition.find((item) => item.financialEntryId === entryId);
    if (!match) continue;
    const repasse = await OwnerRepass.findByPk(log.entityId, { transaction });
    if (!repasse || repasse.status === 'CANCELLED') continue; // repasse cancelado libera o saldo de volta.
    allocatedCents += Math.round(Number(match.eligibleAmount || 0) * 100);
  }
  return allocatedCents / 100;
}

// Regra ÚNICA de elegibilidade de um recebimento como fonte de repasse — usada tanto na
// validação da criação (assertEligibleSources) quanto na lista de elegíveis da tela
// (listEligibleRepasseSources). Devolve null quando elegível.
function sourceIneligibility(entry) {
  if (entry.nature !== 'RECEIVABLE') {
    return {
      code: 'FINANCE_OWNER_REPASSE_SOURCE_NOT_RECEIVABLE',
      message: `O lançamento ${entry.id} não é um recebimento (nature=${entry.nature}) — não pode compor o valor elegível do repasse.`,
    };
  }
  if (!['SETTLED', 'PARTIALLY_SETTLED'].includes(entry.status)) {
    return {
      code: 'FINANCE_OWNER_REPASSE_SOURCE_NOT_RECEIVED',
      message: `O lançamento ${entry.id} ainda não foi recebido (status=${entry.status}) — só recebimento REAL pode compor o teto elegível.`,
    };
  }
  if (entry.isThirdPartyFunds) {
    return {
      code: 'FINANCE_OWNER_REPASSE_SOURCE_THIRD_PARTY',
      message: `O lançamento ${entry.id} é dinheiro de terceiro (caução) — não compõe o valor elegível de repasse próprio (FIN-006).`,
    };
  }
  return null;
}

// M45 F4: escopo — recebimento vinculado a contrato só compõe repasse daquele contrato (se o
// repasse tem contrato) ou de contrato do MESMO imóvel (se o repasse é só do imóvel). Recebimento
// sem contrato (lançamento avulso) não tem como ser ligado a um imóvel: continua aceito pela API
// (compatibilidade), mas não é sugerido na lista de elegíveis.
const REPASSE_STATUS_PT = { PENDING: 'aguardando aprovação', APPROVED: 'aprovado', PAID: 'pago', CANCELLED: 'cancelado' };

async function assertSourcesInScope(entries, { propertyId, contractId }, transaction) {
  const contractIds = [...new Set(entries.map((e) => e.contractId).filter(Boolean))];
  if (contractIds.length === 0) return;
  const contracts = await Contract.findAll({ where: { id: contractIds }, attributes: ['id', 'propertyId'], transaction });
  const propertyByContract = new Map(contracts.map((c) => [c.id, c.propertyId]));
  for (const entry of entries) {
    if (!entry.contractId) continue;
    const ok = contractId
      ? String(entry.contractId) === String(contractId)
      : String(propertyByContract.get(entry.contractId) || '') === String(propertyId);
    if (!ok) {
      throw AppError.conflict(
        `O recebimento "${entry.description || entry.id}" é de outro ${contractId ? 'contrato' : 'imóvel'} — não pode compor este repasse.`,
        'FINANCE_OWNER_REPASSE_SOURCE_OUT_OF_SCOPE',
        { financialEntryId: entry.id }
      );
    }
  }
}

async function allocatedAmountsByEntry(transaction) {
  const logs = await AuditLog.findAll({ where: { action: 'finance.owner_repasse.create', entityType: 'OwnerRepass' }, transaction });
  const repasseIds = [...new Set(logs.map((l) => l.entityId))];
  const live = repasseIds.length
    ? new Set((await OwnerRepass.findAll({ where: { id: repasseIds, status: { [Op.ne]: 'CANCELLED' } }, attributes: ['id'], transaction })).map((r) => r.id))
    : new Set();
  const cents = new Map();
  for (const log of logs) {
    if (!live.has(log.entityId)) continue;
    for (const item of (log.afterJson && Array.isArray(log.afterJson.composition) ? log.afterJson.composition : [])) {
      cents.set(item.financialEntryId, (cents.get(item.financialEntryId) || 0) + Math.round(Number(item.eligibleAmount || 0) * 100));
    }
  }
  return cents;
}

/**
 * listEligibleRepasseSources — recebimentos que podem compor um repasse do imóvel/contrato/período
 * escolhidos: mesma regra de sourceIneligibility + escopo (contrato do imóvel, ou o contrato
 * escolhido) + competência até o período do repasse + saldo ainda não alocado > 0.
 */
async function listEligibleRepasseSources(transaction, filters = {}) {
  const { propertyId, contractId, referenceMonth } = filters;
  if (!propertyId) {
    throw AppError.badRequest('Escolha o imóvel para listar os recebimentos elegíveis ao repasse.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (referenceMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(referenceMonth))) {
    throw AppError.badRequest('O período deve estar no formato AAAA-MM.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  let contractIds;
  if (contractId) {
    const c = await Contract.findOne({ where: { id: contractId, propertyId }, attributes: ['id'], transaction });
    contractIds = c ? [c.id] : [];
  } else {
    contractIds = (await Contract.findAll({ where: { propertyId }, attributes: ['id'], transaction })).map((c) => c.id);
  }
  if (contractIds.length === 0) return [];
  const where = { contractId: contractIds, nature: 'RECEIVABLE', status: ['SETTLED', 'PARTIALLY_SETTLED'], isThirdPartyFunds: false };
  if (referenceMonth) where.competenceMonth = { [Op.lte]: referenceMonth };
  const entries = await FinancialEntry.findAll({ where, order: [['settledAt', 'DESC'], ['created_at', 'DESC']], transaction });
  const allocated = await allocatedAmountsByEntry(transaction);
  const out = [];
  for (const entry of entries) {
    if (sourceIneligibility(entry)) continue;
    const availableCents = Math.max(0, Math.round(eligibleAmountOf(entry) * 100) - (allocated.get(entry.id) || 0));
    if (availableCents <= 0) continue;
    out.push({
      id: entry.id,
      description: entry.description,
      contractId: entry.contractId,
      competenceMonth: entry.competenceMonth,
      settledAt: entry.settledAt,
      amount: Number(entry.amount),
      alreadyAllocatedAmount: (allocated.get(entry.id) || 0) / 100,
      availableAmount: availableCents / 100,
    });
  }
  return out;
}

async function assertEligibleSources(companyId, sourceEntryIds, transaction) {
  if (!Array.isArray(sourceEntryIds) || sourceEntryIds.length === 0) {
    throw AppError.badRequest(
      'Escolha ao menos um recebimento: o repasse precisa estar ligado a recebimento(s) reais.',
      'FINANCE_OWNER_REPASSE_VALIDATION'
    );
  }
  const uniqueIds = [...new Set(sourceEntryIds)];
  // FOR UPDATE (Frente 3, §12): dois repasses concorrentes sobre o mesmo recebimento ficam em
  // fila — o segundo só lê o saldo já alocado depois que o primeiro terminar (sem repasse duplo).
  const entries = await FinancialEntry.findAll({
    where: { id: uniqueIds, companyId },
    order: [['id', 'ASC']],
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (entries.length !== uniqueIds.length) {
    throw AppError.notFound(
      'Um ou mais recebimentos escolhidos não foram encontrados nesta empresa.',
      'FINANCE_OWNER_REPASSE_SOURCE_NOT_FOUND'
    );
  }
  for (const entry of entries) {
    const problem = sourceIneligibility(entry);
    if (problem) throw AppError.conflict(problem.message, problem.code);
  }
  return entries;
}

function eligibleAmountOf(entry) {
  // Recebimento SETTLED: todo o amount é elegível. PARTIALLY_SETTLED: só a parte já realmente
  // recebida (soma das baixas filhas SETTLED) entra no teto — nunca o saldo ainda não recebido.
  if (entry.status === 'SETTLED') return Number(entry.amount);
  return 0; // PARTIALLY_SETTLED tratado via computeRemainingAmount pelo chamador quando necessário.
}

/**
 * createOwnerRepasse — `sourceEntryIds` (obrigatório) aponta para os lançamentos de recebimento
 * REAIS que formam o valor elegível. `grossAmount`, quando informado, é só uma conveniência de
 * exibição (percentual/regra aplicada) mas NUNCA pode exceder a soma elegível dos
 * `sourceEntryIds`, salvo `formalAdjustment` explícito. netAmount = min(grossAmount, teto) -
 * deductionsAmount (sempre recalculado server-side).
 */
async function createOwnerRepasse(payload, actorUserId, transaction) {
  const {
    groupId,
    companyId,
    propertyId,
    ownerPersonId,
    contractId,
    bankAccountId,
    sourceEntryIds,
    grossAmount,
    deductionsAmount,
    deductionsReason,
    deductionsDocumentFileId,
    referenceMonth,
    idempotencyKey,
    formalAdjustment,
  } = payload;

  if (!groupId || !companyId || !propertyId || !ownerPersonId) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "propertyId" e "ownerPersonId" são obrigatórios.',
      'FINANCE_OWNER_REPASSE_VALIDATION'
    );
  }

  // Período definido (§12, Frente 3): todo repasse é de uma competência — sem isso não há como
  // impedir dois repasses do mesmo período (ver índice owner_repasses_one_per_period_uq).
  if (!referenceMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(referenceMonth))) {
    throw AppError.badRequest('Informe o período do repasse (mês/ano).', 'FINANCE_OWNER_REPASSE_PERIOD_REQUIRED');
  }
  const samePeriod = await OwnerRepass.findOne({
    where: { companyId, ownerPersonId, propertyId, contractId: contractId || null, referenceMonth, status: ['PENDING', 'APPROVED', 'PAID'] },
    transaction,
  });
  if (samePeriod) {
    throw AppError.conflict(
      `Já existe um repasse para este proprietário e imóvel no período ${formatCompetenceBR(referenceMonth)} (situação: ${REPASSE_STATUS_PT[samePeriod.status] || samePeriod.status}). Cancele o anterior antes de criar outro.`,
      'FINANCE_OWNER_REPASSE_PERIOD_DUPLICATE',
      { existingId: samePeriod.id }
    );
  }

  const sourceEntries = await assertEligibleSources(companyId, sourceEntryIds, transaction);
  await assertSourcesInScope(sourceEntries, { propertyId, contractId }, transaction);
  // remainingCentsByEntry = quanto deste lançamento ainda não foi consumido por repasses
  // anteriores não cancelados — é o "saldo disponível" real deste recebimento para repasse.
  const remainingCentsByEntry = new Map();
  let eligibleCents = 0;
  for (const entry of sourceEntries) {
    const alreadyAllocated = await getAlreadyAllocatedAmount(entry.id, transaction);
    const remainingCents = Math.max(0, Math.round((eligibleAmountOf(entry) - alreadyAllocated) * 100));
    remainingCentsByEntry.set(entry.id, remainingCents);
    eligibleCents += remainingCents;
  }
  const eligibleAmount = eligibleCents / 100;

  const grossNumeric = grossAmount === undefined || grossAmount === null ? eligibleAmount : Number(grossAmount);
  const deductionsNumeric = Number(deductionsAmount) || 0;
  if (!Number.isFinite(grossNumeric) || grossNumeric <= 0) {
    throw AppError.badRequest('O valor bruto do repasse precisa ser um número positivo.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (deductionsNumeric < 0 || deductionsNumeric > grossNumeric) {
    throw AppError.badRequest('A dedução não pode ser negativa nem maior que o valor bruto do repasse.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  if (referenceMonth && !/^\d{4}-\d{2}$/.test(referenceMonth)) {
    throw AppError.badRequest('O período do repasse precisa estar no formato mês/ano (ex.: 10/2026).', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }

  // "Repasse não pode ser maior que valor elegível recebido, salvo ajuste formal." Sem
  // formalAdjustment documentado (motivo + aprovador), exceder o teto é SEMPRE bloqueado.
  if (round2(grossNumeric) > round2(eligibleAmount)) {
    const hasFormalAdjustment =
      formalAdjustment && typeof formalAdjustment.reason === 'string' && formalAdjustment.reason.trim() && formalAdjustment.approvedByUserId;
    if (!hasFormalAdjustment) {
      throw AppError.conflict(
        `O valor do repasse (${formatMoneyBR(round2(grossNumeric))}) é maior que o valor elegível recebido dos lançamentos escolhidos ` +
          `(${formatMoneyBR(round2(eligibleAmount))}) — bloqueado. Para exceder, é preciso um ajuste formal com motivo e aprovador.`,
        'FINANCE_OWNER_REPASSE_EXCEEDS_ELIGIBLE_CAP'
      );
    }
  }

  // Caderno M4 §12: "Desconto precisa de motivo/documento/regra." Dedução sem motivo é recusada.
  const deductionsReasonText = typeof deductionsReason === 'string' ? deductionsReason.trim() : '';
  if (deductionsNumeric > 0 && !deductionsReasonText) {
    throw AppError.badRequest('Dedução no repasse exige o motivo do desconto.', 'FINANCE_OWNER_REPASSE_DEDUCTION_REASON_REQUIRED');
  }

  await assertNoDuplicatePayment(OwnerRepass, idempotencyKey, transaction);

  const netAmount = round2(grossNumeric - deductionsNumeric);

  const repasse = await OwnerRepass.create(
    {
      groupId,
      companyId,
      propertyId,
      ownerPersonId,
      contractId: contractId || null,
      bankAccountId: bankAccountId || null,
      grossAmount: grossNumeric,
      deductionsAmount: deductionsNumeric,
      deductionsReason: deductionsReasonText || null,
      deductionsDocumentFileId: deductionsDocumentFileId || null,
      netAmount,
      referenceMonth,
      status: 'PENDING',
      idempotencyKey: idempotencyKey || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await publishOwnerRepasseCreated(repasse, transaction);

  // Composição (M4-contrato §12 "Extrato do proprietário mostra composição, não apenas valor
  // líquido."): cada lançamento-fonte entra com o valor REALMENTE consumido por ESTE repasse
  // (drenado greedily do saldo disponível de cada entry, respeitando a ordem informada em
  // sourceEntryIds), não o teto cheio do lançamento — é esse valor que fica "reservado" e é
  // descontado do saldo disponível de futuros repasses sobre o mesmo lançamento (ver
  // getAlreadyAllocatedAmount). Isso é o que impede dois repasses reutilizarem o mesmo saldo.
  let remainingGrossCentsToDraw = Math.round(grossNumeric * 100);
  const composition = sourceEntries.map((entry) => {
    const availableCents = remainingCentsByEntry.get(entry.id) || 0;
    const drawnCents = Math.min(availableCents, remainingGrossCentsToDraw);
    remainingGrossCentsToDraw -= drawnCents;
    return {
      financialEntryId: entry.id,
      description: entry.description,
      eligibleAmount: drawnCents / 100,
    };
  });

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.owner_repasse.create',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      afterJson: { ...repasse.toJSON(), eligibleAmount: round2(eligibleAmount), composition, formalAdjustment: formalAdjustment || null },
      reason: `Repasse de ${netAmount} (bruto ${grossNumeric} - deduções ${deductionsNumeric}) registrado — teto elegível ${round2(eligibleAmount)} de ${sourceEntries.length} recebimento(s).`,
    },
    transaction
  );

  return repasse;
}

/**
 * getOwnerRepasseComposition — devolve a composição (lançamentos-fonte + valor elegível de
 * cada) registrada no momento da criação do repasse, lendo o rastro de auditoria append-only
 * (ver nota de modelagem acima). "Extrato do proprietário mostra composição, não apenas valor
 * líquido." — esta função é o que alimenta essa visão.
 */
async function getOwnerRepasseComposition(ownerRepasseId, transaction) {
  const log = await AuditLog.findOne({
    where: { action: 'finance.owner_repasse.create', entityType: 'OwnerRepass', entityId: ownerRepasseId },
    order: [['created_at', 'ASC']],
    transaction,
  });
  if (!log) throw AppError.notFound('Nenhum registro de criação encontrado para este repasse.', 'FINANCE_OWNER_REPASSE_NOT_FOUND');
  const afterJson = log.afterJson || {};
  return {
    ownerRepasseId,
    eligibleAmount: afterJson.eligibleAmount || null,
    composition: afterJson.composition || [],
    formalAdjustment: afterJson.formalAdjustment || null,
  };
}

async function listOwnerRepasses(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.ownerPersonId) where.ownerPersonId = filters.ownerPersonId;
  if (filters.propertyId) where.propertyId = filters.propertyId;
  return OwnerRepass.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

async function getOwnerRepasse(id, transaction, options = {}) {
  const repasse = await OwnerRepass.findByPk(id, { transaction, lock: options.lock && transaction ? transaction.LOCK.UPDATE : undefined });
  if (!repasse) throw AppError.notFound('Repasse não encontrado.', 'FINANCE_OWNER_REPASSE_NOT_FOUND');
  return repasse;
}

/**
 * approveOwnerRepasse — §12 / Frente 3: OUTRA pessoa (não quem registrou) aprova o repasse. Só
 * aqui nasce o lançamento a pagar (PAYABLE) que efetiva o pagamento — o mesmo caminho de todo
 * pagamento (intenção bancária com confirmação, ou baixa manual com comprovante aprovado).
 * FOR UPDATE no repasse: duas aprovações simultâneas não criam dois lançamentos.
 */
async function approveOwnerRepasse(id, payload, actorUserId, transaction) {
  const repasse = await getOwnerRepasse(id, transaction, { lock: true });
  if (repasse.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível aprovar um repasse PENDING (atual: "${repasse.status}").`, 'FINANCE_OWNER_REPASSE_INVALID_STATUS');
  }
  if (!actorUserId || (repasse.createdBy && String(repasse.createdBy) === String(actorUserId))) {
    throw AppError.forbidden(
      'Quem registrou o repasse não pode aprová-lo — a aprovação precisa ser de outra pessoa (maker-checker).',
      'FINANCE_OWNER_REPASSE_SELF_APPROVAL_FORBIDDEN'
    );
  }
  if (!repasse.referenceMonth) {
    throw AppError.conflict('Repasse sem período definido não pode ser aprovado.', 'FINANCE_OWNER_REPASSE_PERIOD_REQUIRED');
  }
  const bankAccountId = repasse.bankAccountId || (payload && payload.bankAccountId);
  if (!bankAccountId) {
    throw AppError.badRequest('Informe a conta bancária de saída do repasse.', 'FINANCE_OWNER_REPASSE_BANK_ACCOUNT_REQUIRED');
  }
  const costCenterId = payload && payload.costCenterId;
  if (!costCenterId) {
    throw AppError.badRequest('Informe o centro de custo do pagamento do repasse.', 'FINANCE_OWNER_REPASSE_VALIDATION');
  }
  await assertBankAccountEligibleForPayment(bankAccountId, transaction);

  // M45: texto do lançamento sem UUID e com período no formato brasileiro.
  const owner = await Person.findByPk(repasse.ownerPersonId, { attributes: ['legalName'], transaction });
  const [refYear, refMonth] = String(repasse.referenceMonth).split('-');
  const periodBR = refMonth ? `${refMonth}/${refYear}` : repasse.referenceMonth;
  const entry = await entriesService().createFinancialEntry(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      bankAccountId,
      costCenterId,
      contractId: repasse.contractId || null,
      entryType: 'DEBIT',
      nature: 'PAYABLE',
      amount: Number(repasse.netAmount),
      description: `Repasse ao proprietário${owner ? ` ${owner.legalName}` : ''} — período ${periodBR}`,
      dueAt: (payload && payload.dueAt) || null,
      competenceMonth: (payload && payload.competenceMonth) || undefined,
      idempotencyKey: `owner-repasse:${repasse.id}`,
      // Dinheiro do proprietário é de terceiro: não entra como despesa própria nos relatórios.
      isThirdPartyFunds: true,
      thirdPartyReference: `Repasse ao proprietário${owner ? ` ${owner.legalName}` : ''} — período ${periodBR}`,
    },
    actorUserId,
    transaction,
    { ownerRepasseId: repasse.id }
  );

  const beforeJson = repasse.toJSON();
  repasse.status = 'APPROVED';
  repasse.bankAccountId = bankAccountId;
  repasse.financialEntryId = entry.id;
  repasse.approvedByUserId = actorUserId;
  repasse.approvedAt = new Date();
  repasse.updatedBy = actorUserId;
  await repasse.save({ transaction });

  await registrarAuditoria(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      actorUserId,
      action: 'finance.owner_repasse.approve',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      beforeJson,
      afterJson: repasse.toJSON(),
      reason: `Repasse de ${repasse.netAmount} (período ${repasse.referenceMonth}) aprovado por outra pessoa — lançamento a pagar ${entry.id} criado.`,
    },
    transaction
  );
  return { repasse, financialEntry: entry };
}

/**
 * payOwnerRepasse — CONFIRMAÇÃO do pagamento (§12 / Frente 3). Antes, marcava PAID direto, sem
 * aprovação, sem comprovante e sem trava. Agora: FOR UPDATE no repasse; precisa estar APPROVED;
 * o lançamento a pagar por trás precisa estar SETTLED — liquidado por confirmação do banco ou por
 * baixa manual com comprovante aprovado (regras de financialEntries.settleFinancialEntry). O
 * comprovante/método fica gravado no repasse.
 */
async function payOwnerRepasse(id, actorUserId, transaction) {
  const repasse = await getOwnerRepasse(id, transaction, { lock: true });
  if (repasse.status === 'PAID') {
    throw AppError.conflict('Este repasse já foi pago.', 'FINANCE_OWNER_REPASSE_ALREADY_PAID');
  }
  if (repasse.status !== 'APPROVED' || !repasse.financialEntryId) {
    throw AppError.conflict(
      `Só é possível confirmar o pagamento de um repasse APROVADO (atual: "${repasse.status}").`,
      'FINANCE_OWNER_REPASSE_NOT_APPROVED'
    );
  }
  const entry = await FinancialEntry.findByPk(repasse.financialEntryId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!entry || entry.status !== 'SETTLED') {
    throw AppError.conflict(
      'O pagamento do repasse ainda não foi confirmado: o lançamento a pagar precisa estar liquidado (confirmação do banco ou baixa manual com comprovante aprovado).',
      'FINANCE_OWNER_REPASSE_PAYMENT_NOT_CONFIRMED',
      { financialEntryId: repasse.financialEntryId, entryStatus: entry ? entry.status : null }
    );
  }
  const bankConfirmed = ['BANK_CONFIRMED', 'SANDBOX_CONFIRMED'].includes(entry.settlementMethod);
  if (!bankConfirmed && !entry.settlementEvidenceFileId) {
    throw AppError.conflict(
      'O pagamento do repasse não tem comprovante nem confirmação bancária.',
      'FINANCE_OWNER_REPASSE_EVIDENCE_REQUIRED'
    );
  }

  const beforeJson = repasse.toJSON();
  repasse.status = 'PAID';
  repasse.paidAt = entry.settledAt || new Date();
  repasse.confirmedByUserId = actorUserId || null;
  repasse.paymentSettlementMethod = entry.settlementMethod || 'MANUAL_WITH_EVIDENCE';
  repasse.paymentEvidenceFileId = entry.settlementEvidenceFileId || null;
  repasse.updatedBy = actorUserId || null;
  await repasse.save({ transaction });

  await registrarAuditoria(
    {
      groupId: repasse.groupId,
      companyId: repasse.companyId,
      actorUserId,
      action: 'finance.owner_repasse.pay',
      entityType: 'OwnerRepass',
      entityId: repasse.id,
      beforeJson,
      afterJson: repasse.toJSON(),
      reason: `Repasse de ${repasse.netAmount} (período ${repasse.referenceMonth}) confirmado como pago — ${repasse.paymentSettlementMethod}${repasse.paymentEvidenceFileId ? `, comprovante ${repasse.paymentEvidenceFileId}` : ''}.`,
    },
    transaction
  );
  await publishOwnerRepassCompleted(repasse, transaction);

  return repasse;
}

module.exports = {
  createOwnerRepasse,
  listOwnerRepasses,
  listEligibleRepasseSources,
  getOwnerRepasse,
  getOwnerRepasseComposition,
  approveOwnerRepasse,
  payOwnerRepasse,
  STATUSES,
};
