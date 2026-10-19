'use strict';

const crypto = require('crypto');
const { Commission, CommissionInstallment, FinancialEntry, AuditLog, Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { evaluateRule } = require('../../engines/rules/rulesEngine');
const { publishCommissionCreated } = require('./financeEvents.service');
const { computeRemainingAmount } = require('./financialEntries.service');

// BUG REAL CORRIGIDO (auditoria externa Nayara, 2026-10-09 — mesmo padrão do achado em
// inventory.movements.service.js/recordMovement): criar uma comissão é uma operação
// REEXECUTÁVEL (POST manual, retry de rede/duplo-clique reenvia o mesmo cálculo) que gera uma
// obrigação financeira real (Commission + parcelas), e não tinha NENHUMA proteção contra
// duplicidade — nem campo de idempotência, nem UNIQUE constraint que pegasse o caso. Fail
// closed: idempotencyKey agora é obrigatória aqui, única por empresa (migration
// 20260101000325-add-idempotency-key-to-commissions.js).

const STATUSES = ['PENDING', 'APPROVED', 'PAID', 'CANCELLED'];

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// --- Caderno §14 / FIN-011 — regra de comissão no Motor de Regras ---------------------------
//
// Conferência Nayara 18/10/2026: o percentual vinha do payload e `ruleVersionId` era opcional.
// §14: "Direito de comissão nasce de fato gerador definido pelo Motor de Regras. Percentual e
// base guardam rule_version_id usado no cálculo. Comissão pode ser parcelada na mesma proporção
// do recebimento. Comissão de gerente/corretor/correspondente são componentes separados.
// Pagamento da comissão exige disponibilidade/condição prevista na regra."
//
// Agora:
//  - REG-FIN-002 (Motor de Regras genérico, versionado) define o percentual de cada componente
//    (BROKER/MANAGER/CORRESPONDENT) e a base (o valor do lançamento a receber de origem).
//  - O fato gerador é um lançamento a RECEBER real (`sourceEntryId`); a base é o valor dele.
//  - Percentual e base NUNCA vêm do payload; a comissão grava a versão da regra usada.
//  - Sem regra publicada: fail closed (não existe percentual padrão inventado para dinheiro).
//  - O pagamento é liberado na proporção do que o fato gerador já recebeu (ver
//    getCommissionRelease / markInstallmentPaid).

const RULE_CODE = 'REG-FIN-002';
const RULE_NAME = 'Percentual de comissão por componente (fato gerador: recebimento)';
const CONDITION_AST = { fact: 'commissionRuleActive', op: '==', value: true };
const COMPONENTS = ['BROKER', 'MANAGER', 'CORRESPONDENT'];
const BASE_TYPE = 'SOURCE_ENTRY_AMOUNT';

function validateComponentPercentages(componentPercentages) {
  if (!componentPercentages || typeof componentPercentages !== 'object' || Array.isArray(componentPercentages)) {
    throw AppError.badRequest(
      `"componentPercentages" é obrigatório: objeto com o percentual de cada componente (${COMPONENTS.join(', ')}).`,
      'FINANCE_COMMISSION_RULE_VALIDATION'
    );
  }
  const normalized = {};
  for (const [key, value] of Object.entries(componentPercentages)) {
    if (!COMPONENTS.includes(key)) {
      throw AppError.badRequest(`Componente desconhecido "${key}". Use: ${COMPONENTS.join(', ')}.`, 'FINANCE_COMMISSION_RULE_VALIDATION');
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 100) {
      throw AppError.badRequest(`O percentual de "${key}" deve estar entre 0 (exclusivo) e 100.`, 'FINANCE_COMMISSION_RULE_VALIDATION');
    }
    normalized[key] = numeric;
  }
  if (Object.keys(normalized).length === 0) {
    throw AppError.badRequest('Informe o percentual de pelo menos um componente.', 'FINANCE_COMMISSION_RULE_VALIDATION');
  }
  return normalized;
}

/**
 * publishCommissionRuleVersion — publica nova versão de REG-FIN-002 (a anterior tem a vigência
 * encerrada; comissões já calculadas continuam apontando para a versão que usaram).
 */
async function publishCommissionRuleVersion(payload, actorUserId, transaction) {
  const { groupId, companyId, componentPercentages, description } = payload;
  if (!groupId || !companyId) {
    throw AppError.badRequest('Os campos "groupId" e "companyId" são obrigatórios.', 'FINANCE_COMMISSION_RULE_VALIDATION');
  }
  const normalized = validateComponentPercentages(componentPercentages);

  const lockKey = `commission_rule:${groupId}:${companyId}:${RULE_CODE}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', { replacements: { lockKey }, transaction });

  let rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  if (!rule) {
    rule = await Rule.create(
      {
        groupId,
        companyId,
        code: RULE_CODE,
        name: RULE_NAME,
        description: 'Percentual de comissão de corretor/gerente/correspondente sobre o valor do recebimento que gera o direito (Caderno §14).',
        domain: 'finance',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
  }
  const now = new Date();
  // Auditoria antes/depois: a versão vigente antes desta publicação.
  const previous = await RuleVersion.findOne({ where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, order: [['versionNumber', 'DESC']], transaction });
  const beforeJson = previous
    ? { ruleCode: RULE_CODE, versionNumber: previous.versionNumber, ...(previous.actionJson || {}), effectiveFrom: previous.effectiveFrom, effectiveUntil: null }
    : { ruleCode: RULE_CODE, versionNumber: null, components: {}, situacao: 'nenhuma versão publicada' };
  await RuleVersion.update(
    { effectiveUntil: now, updatedBy: actorUserId || null },
    { where: { ruleId: rule.id, status: 'PUBLISHED', effectiveUntil: null }, transaction }
  );
  const last = await RuleVersion.findOne({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  const actionJson = { components: normalized, base: BASE_TYPE, description: description || null };
  const version = await RuleVersion.create(
    {
      groupId,
      companyId,
      ruleId: rule.id,
      versionNumber: last ? last.versionNumber + 1 : 1,
      conditionAstJson: CONDITION_AST,
      contentHash: crypto.createHash('sha256').update(JSON.stringify({ CONDITION_AST, actionJson })).digest('hex'),
      actionJson,
      effectiveFrom: now,
      effectiveUntil: null,
      status: 'PUBLISHED',
      publishedByUserId: actorUserId || null,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );
  await RuleScope.create(
    { groupId, companyId, ruleVersionId: version.id, scopeType: 'GLOBAL', scopeRefId: null, precedence: 7, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  await RulePublication.create(
    { groupId, companyId, ruleVersionId: version.id, publishedByUserId: actorUserId || null, publishedAt: now, createdBy: actorUserId || null, updatedBy: actorUserId || null },
    { transaction }
  );
  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.commission_rule.publish',
      entityType: 'RuleVersion',
      entityId: version.id,
      beforeJson,
      afterJson: { ruleCode: RULE_CODE, versionNumber: version.versionNumber, ...actionJson, effectiveFrom: now, effectiveUntil: null },
      reason: `Nova versão da regra de comissão (${RULE_CODE} v${version.versionNumber}) publicada.`,
    },
    transaction
  );
  return { id: version.id, ruleCode: RULE_CODE, versionNumber: version.versionNumber, components: normalized, base: BASE_TYPE };
}

async function resolveCommissionRule(groupId, companyId, transaction) {
  const evaluation = await evaluateRule(RULE_CODE, { commissionRuleActive: true, groupId, companyId }, { groupId, companyId }, { transaction });
  if (evaluation.decision !== 'APPLY') {
    throw AppError.unprocessable(
      `Não há regra de comissão publicada para esta empresa (${RULE_CODE}) — publique o percentual de cada componente antes de registrar comissões.`,
      'FINANCE_COMMISSION_RULE_NOT_CONFIGURED',
      { reason: evaluation.reason }
    );
  }
  return { ruleVersionId: evaluation.ruleVersionId, action: evaluation.action || {} };
}

async function getActiveCommissionRule(groupId, companyId, transaction) {
  const { ruleVersionId, action } = await resolveCommissionRule(groupId, companyId, transaction);
  // M45: número da versão e início de vigência para a tela mostrar "versão 3, desde dd/mm/aaaa"
  // em vez do identificador interno.
  const version = ruleVersionId ? await RuleVersion.findByPk(ruleVersionId, { attributes: ['versionNumber', 'effectiveFrom'], transaction }) : null;
  return {
    ruleVersionId,
    versionNumber: version ? version.versionNumber : null,
    effectiveFrom: version ? version.effectiveFrom : null,
    ruleCode: RULE_CODE,
    components: action.components || {},
    base: action.base || BASE_TYPE,
  };
}

/**
 * listCommissionRuleVersions — M45-RECONF F3: histórico completo das versões publicadas da regra
 * (número, percentuais, vigência, quem publicou e quando), da mais nova para a mais antiga.
 */
async function listCommissionRuleVersions(groupId, companyId, transaction) {
  const { User } = require('../../models');
  const rule = await Rule.findOne({ where: { code: RULE_CODE, groupId, companyId }, transaction });
  if (!rule) return [];
  const versions = await RuleVersion.findAll({ where: { ruleId: rule.id }, order: [['versionNumber', 'DESC']], transaction });
  const publisherIds = [...new Set(versions.map((v) => v.publishedByUserId || v.createdBy).filter(Boolean))];
  const users = publisherIds.length ? await User.findAll({ where: { id: publisherIds }, attributes: ['id', 'name', 'email'], transaction }) : [];
  const nameById = new Map(users.map((u) => [u.id, u.name || u.email]));
  return versions.map((v) => {
    const publisherId = v.publishedByUserId || v.createdBy || null;
    return {
      id: v.id,
      versionNumber: v.versionNumber,
      status: v.status,
      components: (v.actionJson && v.actionJson.components) || {},
      base: (v.actionJson && v.actionJson.base) || BASE_TYPE,
      effectiveFrom: v.effectiveFrom,
      effectiveUntil: v.effectiveUntil,
      current: v.status === 'PUBLISHED' && !v.effectiveUntil,
      publishedByName: publisherId ? (nameById.get(publisherId) || 'Usuário removido') : 'Sistema (carga inicial)',
      publishedAt: v.effectiveFrom || v.createdAt,
    };
  });
}

/**
 * createCommission — registra o DIREITO à comissão a partir do fato gerador (lançamento a
 * receber `sourceEntryId`) e do componente. Percentual e base vêm da regra REG-FIN-002 vigente;
 * a comissão grava a `ruleVersionId` usada.
 */
async function createCommission(payload, actorUserId, transaction) {
  const { groupId, companyId, opportunityId, contractId, beneficiaryUserId, sourceEntryId, component, installmentsCount, firstDueAt, idempotencyKey } = payload;

  if (!groupId || !companyId || !beneficiaryUserId || !sourceEntryId || !component) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId", "beneficiaryUserId", "sourceEntryId" (fato gerador) e "component" são obrigatórios.',
      'FINANCE_COMMISSION_VALIDATION'
    );
  }
  if (payload.percentage !== undefined || payload.baseAmount !== undefined || payload.ruleVersionId !== undefined) {
    throw AppError.badRequest(
      'Percentual, base e versão da regra não são informados no pedido: vêm da regra de comissão vigente (Caderno §14).',
      'FINANCE_COMMISSION_VALUES_FROM_RULE'
    );
  }
  const normalizedComponent = String(component).toUpperCase();
  if (!COMPONENTS.includes(normalizedComponent)) {
    throw AppError.badRequest(`O campo "component" deve ser um de: ${COMPONENTS.join(', ')}.`, 'FINANCE_COMMISSION_VALIDATION');
  }
  if (!idempotencyKey) {
    throw AppError.badRequest(
      'O campo "idempotencyKey" é obrigatório — evita duplicar a obrigação de comissão em caso de retry/duplo-clique.',
      'FINANCE_COMMISSION_IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  const existingByKey = await Commission.findOne({ where: { companyId, idempotencyKey }, transaction });
  if (existingByKey) {
    throw AppError.conflict(
      'Já existe uma comissão criada com esta mesma chave de idempotência — envio duplicado bloqueado.',
      'FINANCE_COMMISSION_DUPLICATE',
      { existingId: existingByKey.id }
    );
  }

  const sourceEntry = await FinancialEntry.findOne({
    where: { id: sourceEntryId, companyId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (!sourceEntry) {
    throw AppError.notFound('O lançamento de origem (fato gerador) não existe nesta empresa.', 'FINANCE_COMMISSION_SOURCE_NOT_FOUND');
  }
  if (sourceEntry.nature !== 'RECEIVABLE' || sourceEntry.isThirdPartyFunds || ['CANCELLED', 'REVERSED'].includes(sourceEntry.status) || sourceEntry.parentEntryId) {
    throw AppError.conflict(
      'O fato gerador da comissão precisa ser um lançamento a receber próprio e válido (não caução, não cancelado/estornado, não baixa parcial).',
      'FINANCE_COMMISSION_SOURCE_INVALID'
    );
  }
  const duplicateFact = await Commission.findOne({
    where: { companyId, sourceEntryId, component: normalizedComponent, beneficiaryUserId, status: ['PENDING', 'APPROVED', 'PAID'] },
    transaction,
  });
  if (duplicateFact) {
    throw AppError.conflict(
      'Já existe comissão deste componente para este beneficiário sobre o mesmo fato gerador.',
      'FINANCE_COMMISSION_DUPLICATE_FACT',
      { existingId: duplicateFact.id }
    );
  }

  const { ruleVersionId, action } = await resolveCommissionRule(groupId, companyId, transaction);
  const percentageNumeric = Number((action.components || {})[normalizedComponent]);
  if (!Number.isFinite(percentageNumeric) || percentageNumeric <= 0) {
    throw AppError.unprocessable(
      `A regra de comissão vigente não define percentual para o componente ${normalizedComponent}.`,
      'FINANCE_COMMISSION_RULE_COMPONENT_NOT_CONFIGURED'
    );
  }
  const baseNumeric = Number(sourceEntry.amount);
  const totalAmount = round2(baseNumeric * (percentageNumeric / 100));

  const commission = await Commission.create(
    {
      groupId,
      companyId,
      opportunityId: opportunityId || null,
      contractId: contractId || sourceEntry.contractId || null,
      beneficiaryUserId,
      baseAmount: baseNumeric,
      percentage: percentageNumeric,
      totalAmount,
      ruleVersionId,
      sourceEntryId,
      component: normalizedComponent,
      status: 'PENDING',
      idempotencyKey,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  const installments = await generateInstallments(commission, installmentsCount || 1, firstDueAt, actorUserId, transaction);

  await publishCommissionCreated(commission, transaction);

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'finance.commission.create',
      entityType: 'Commission',
      entityId: commission.id,
      afterJson: { commission: commission.toJSON(), installments: installments.map((i) => i.toJSON()), ruleVersionId, ruleCode: RULE_CODE },
      reason: `Comissão ${normalizedComponent} de ${totalAmount} (${percentageNumeric}% sobre ${baseNumeric}, regra ${RULE_CODE} versão ${ruleVersionId}) registrada a partir do lançamento ${sourceEntryId}.`,
    },
    transaction
  );

  return { commission, installments };
}

/**
 * getCommissionRelease — quanto da comissão já pode ser pago: a mesma proporção do que o fato
 * gerador já recebeu (§14 "parcelada na mesma proporção do recebimento"; §10 "comissão
 * proporcional usa valor efetivamente recebido").
 */
async function getCommissionRelease(commissionOrId, transaction) {
  const commission = typeof commissionOrId === 'string' ? await getCommission(commissionOrId, transaction) : commissionOrId;
  const installments = await CommissionInstallment.findAll({ where: { commissionId: commission.id }, transaction });
  const paidCents = installments.filter((i) => i.status === 'PAID').reduce((acc, i) => acc + Math.round(Number(i.amount) * 100), 0);
  const totalCents = Math.round(Number(commission.totalAmount) * 100);

  if (!commission.sourceEntryId) {
    // Comissão anterior à regra (sem fato gerador registrado): mantém o comportamento antigo.
    return { legacy: true, totalAmount: totalCents / 100, receivedRatio: null, releasedAmount: totalCents / 100, paidAmount: paidCents / 100, availableAmount: (totalCents - paidCents) / 100 };
  }
  const source = await FinancialEntry.findByPk(commission.sourceEntryId, { transaction });
  const baseCents = Math.round(Number(source.amount) * 100);
  let receivedCents = 0;
  if (source.status === 'SETTLED') receivedCents = baseCents;
  else if (source.status === 'PARTIALLY_SETTLED') receivedCents = baseCents - Math.round(Number(await computeRemainingAmount(source, transaction)) * 100);
  receivedCents = Math.max(0, Math.min(receivedCents, baseCents));
  const releasedCents = baseCents > 0 ? Math.floor((totalCents * receivedCents) / baseCents) : 0;
  return {
    legacy: false,
    totalAmount: totalCents / 100,
    sourceEntryId: source.id,
    sourceStatus: source.status,
    receivedAmount: receivedCents / 100,
    receivedRatio: baseCents > 0 ? receivedCents / baseCents : 0,
    releasedAmount: releasedCents / 100,
    paidAmount: paidCents / 100,
    availableAmount: Math.max(0, releasedCents - paidCents) / 100,
  };
}

/**
 * generateInstallments — divide totalAmount em N parcelas iguais (a última absorve a diferença
 * de arredondamento, pra soma das parcelas nunca ficar diferente do totalAmount por causa de
 * centavos — problema clássico de divisão de moeda).
 */
async function generateInstallments(commission, count, firstDueAt, actorUserId, transaction) {
  const n = Math.max(1, Number(count) || 1);
  const baseInstallment = Math.floor((commission.totalAmount / n) * 100) / 100;
  const installments = [];
  let allocated = 0;
  const startDate = firstDueAt ? new Date(firstDueAt) : new Date();

  for (let i = 1; i <= n; i += 1) {
    const isLast = i === n;
    const amount = isLast ? round2(commission.totalAmount - allocated) : baseInstallment;
    allocated = round2(allocated + amount);

    const dueAt = new Date(startDate);
    dueAt.setMonth(dueAt.getMonth() + (i - 1));

    // eslint-disable-next-line no-await-in-loop
    const installment = await CommissionInstallment.create(
      {
        groupId: commission.groupId,
        companyId: commission.companyId,
        commissionId: commission.id,
        installmentNumber: i,
        amount,
        dueAt,
        paidAt: null,
        financialEntryId: null,
        status: 'PENDING',
        createdBy: actorUserId || null,
        updatedBy: actorUserId || null,
      },
      { transaction }
    );
    installments.push(installment);
  }

  return installments;
}

async function listCommissions(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.beneficiaryUserId) where.beneficiaryUserId = filters.beneficiaryUserId;
  const commissions = await Commission.findAll({ where, order: [['created_at', 'DESC']], transaction });
  if (!filters.includeInstallments) return commissions;
  // O2 (auditoria M45): a tela fazia 1 chamada /installments por comissão (N+1, ~3 min).
  // Agora uma única consulta traz as parcelas de todas as comissões listadas.
  const ids = commissions.map((c) => c.id);
  const installments = ids.length
    ? await CommissionInstallment.findAll({ where: { commissionId: ids }, order: [['installment_number', 'ASC']], transaction })
    : [];
  const byCommission = new Map();
  for (const i of installments) {
    if (!byCommission.has(i.commissionId)) byCommission.set(i.commissionId, []);
    byCommission.get(i.commissionId).push(i.toJSON());
  }
  return commissions.map((c) => ({ ...c.toJSON(), installments: byCommission.get(c.id) || [] }));
}

async function getCommission(id, transaction) {
  const commission = await Commission.findByPk(id, { transaction });
  if (!commission) throw AppError.notFound('Comissão não encontrada.', 'FINANCE_COMMISSION_NOT_FOUND');
  return commission;
}

async function listCommissionInstallments(commissionId, transaction) {
  return CommissionInstallment.findAll({ where: { commissionId }, order: [['installment_number', 'ASC']], transaction });
}

/**
 * markInstallmentPaid — vincula a parcela a um lançamento financeiro (financialEntryId) já
 * liquidado — não gera dinheiro novo, só registra a baixa da parcela contra um lançamento real
 * do ledger, evitando dupla contagem.
 */
async function markInstallmentPaid(installmentId, financialEntryId, actorUserId, transaction) {
  const installment = await CommissionInstallment.findByPk(installmentId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!installment) throw AppError.notFound('Parcela de comissão não encontrada.', 'FINANCE_COMMISSION_INSTALLMENT_NOT_FOUND');
  if (installment.status === 'PAID') {
    throw AppError.conflict('Esta parcela já está paga.', 'FINANCE_COMMISSION_INSTALLMENT_ALREADY_PAID');
  }
  if (installment.status !== 'PENDING') {
    throw AppError.conflict(`Só é possível pagar uma parcela pendente (atual: "${installment.status}").`, 'FINANCE_COMMISSION_INSTALLMENT_INVALID_STATUS');
  }
  // Trava a comissão: duas baixas simultâneas não podem somar acima do liberado.
  const commission = await Commission.findByPk(installment.commissionId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!commission || commission.status === 'CANCELLED') {
    throw AppError.conflict('A comissão desta parcela está cancelada.', 'FINANCE_COMMISSION_CANCELLED');
  }
  // §14 "Pagamento da comissão exige disponibilidade/condição prevista na regra": só o que o
  // fato gerador já recebeu (proporcionalmente) pode ser pago.
  const release = await getCommissionRelease(commission, transaction);
  if (Math.round(Number(installment.amount) * 100) > Math.round(release.availableAmount * 100)) {
    throw AppError.conflict(
      `Parcela de ${installment.amount} acima do liberado para pagamento (${release.availableAmount}): a comissão é liberada na proporção do recebimento do fato gerador (recebido ${release.receivedAmount ?? '—'}).`,
      'FINANCE_COMMISSION_NOT_RELEASED',
      { release }
    );
  }

  // FIX (homologação 22/09/2026 — auditoria proativa): o comentário da função já prometia que a
  // baixa "não gera dinheiro novo, só registra contra um lançamento real do ledger, evitando
  // dupla contagem", mas o código nunca checava nada disso — aceitava financialEntryId
  // inexistente, de um lançamento ainda não liquidado, de valor diferente da parcela, já
  // reutilizado por outra parcela, ou nem informado (marcava PAID sem vincular a lançamento
  // nenhum). Agora a validação é real e fail-closed.
  if (!financialEntryId) {
    throw AppError.badRequest(
      'O campo "financialEntryId" é obrigatório para dar baixa na parcela — precisa apontar para um lançamento financeiro já liquidado.',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_REQUIRED'
    );
  }
  const entry = await FinancialEntry.findByPk(financialEntryId, { transaction });
  if (!entry) {
    throw AppError.notFound('Lançamento financeiro informado não encontrado.', 'FINANCE_COMMISSION_INSTALLMENT_ENTRY_NOT_FOUND');
  }
  if (entry.status !== 'SETTLED') {
    throw AppError.conflict(
      'O lançamento financeiro informado ainda não está liquidado (SETTLED).',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_NOT_SETTLED'
    );
  }
  if (round2(entry.amount) !== round2(installment.amount)) {
    throw AppError.conflict(
      'O valor do lançamento financeiro informado não corresponde ao valor da parcela.',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_AMOUNT_MISMATCH'
    );
  }
  const alreadyUsed = await CommissionInstallment.findOne({
    where: { financialEntryId },
    transaction,
  });
  if (alreadyUsed && alreadyUsed.id !== installment.id) {
    throw AppError.conflict(
      'Este lançamento financeiro já foi usado para dar baixa em outra parcela.',
      'FINANCE_COMMISSION_INSTALLMENT_ENTRY_ALREADY_USED'
    );
  }

  const beforeJson = installment.toJSON();
  installment.status = 'PAID';
  installment.paidAt = new Date();
  installment.financialEntryId = financialEntryId;
  installment.updatedBy = actorUserId || null;
  await installment.save({ transaction });

  await registrarAuditoria(
    {
      groupId: installment.groupId,
      companyId: installment.companyId,
      actorUserId,
      action: 'finance.commission_installment.pay',
      entityType: 'CommissionInstallment',
      entityId: installment.id,
      beforeJson,
      afterJson: installment.toJSON(),
      reason: `Parcela ${installment.installmentNumber} da comissão paga (${installment.amount}).`,
    },
    transaction
  );

  return installment;
}

// --- M4-contrato §14 "Comissões" — ajuste por cancelamento ----------------------------------
//
// Auditoria externa (contrato bruto, 2026-10-07): "Reversão/cancelamento gera ajuste, nunca
// apaga histórico." / teste citado "FIN-TS-017 Comissão rollback | Contrato cancelado | Ajuste
// auditável." / "Comissão pode ser parcelada na mesma proporção do recebimento." O status
// CANCELLED já existia no enum, mas nenhuma função o usava — cancelar era, na prática,
// impossível (nada setava esse status) e, se alguém setasse manualmente, não haveria ajuste
// nenhum registrado, nem proporcionalidade com o que já foi pago.
//
// MODELAGEM (DDL indisponível nesta rodada — ver nota de infraestrutura no relatório final): o
// AJUSTE é um registro de auditoria append-only (`audit.audit_log`, action
// "finance.commission.cancel_adjustment") em vez de uma tabela dedicada — mesmo padrão já usado
// em ownerRepasses.service.js (`getOwnerRepasseComposition`) para o mesmo problema de
// infraestrutura. A `Commission` original NUNCA é apagada: só seu `status` muda para
// CANCELLED, e todo o histórico de parcelas (`CommissionInstallment`) permanece intocado — o
// que já foi PAID continua PAID (não se "desfaz" o passado), e o ajuste registra quanto da
// comissão ainda estava em aberto (não pago) no momento do cancelamento, proporcional ao que
// JÁ foi pago/recebido.
async function cancelCommission(commissionId, reasonText, actorUserId, transaction) {
  const commission = await Commission.findByPk(commissionId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
  if (!commission) throw AppError.notFound('Comissão não encontrada.', 'FINANCE_COMMISSION_NOT_FOUND');
  if (commission.status === 'CANCELLED') {
    throw AppError.conflict('Esta comissão já está cancelada.', 'FINANCE_COMMISSION_ALREADY_CANCELLED');
  }
  if (!reasonText || !String(reasonText).trim()) {
    throw AppError.badRequest(
      'O cancelamento de uma comissão exige um motivo documentado (ajuste auditável — FIN-TS-017).',
      'FINANCE_COMMISSION_CANCEL_REASON_REQUIRED'
    );
  }

  const installments = await CommissionInstallment.findAll({ where: { commissionId }, transaction });
  const paidAmountBefore = round2(installments.filter((i) => i.status === 'PAID').reduce((acc, i) => acc + Number(i.amount), 0));
  const totalAmountBefore = round2(commission.totalAmount);
  // Ajuste = o que ainda estava em aberto (não pago) quando o cancelamento aconteceu — é esse
  // valor que deixa de ser devido a partir daqui. Negativo por convenção (reduz o direito).
  const adjustmentAmount = round2(-(totalAmountBefore - paidAmountBefore));

  const beforeJson = { commission: commission.toJSON(), installments: installments.map((i) => i.toJSON()) };

  commission.status = 'CANCELLED';
  commission.updatedBy = actorUserId || null;
  await commission.save({ transaction });

  // Parcelas ainda não pagas são canceladas (preservando a linha — nunca DELETE); as já PAID
  // permanecem PAID, intocadas, exatamente como "nunca apaga histórico" exige.
  for (const installment of installments) {
    if (installment.status === 'PENDING') {
      // eslint-disable-next-line no-await-in-loop
      installment.status = 'CANCELLED';
      installment.updatedBy = actorUserId || null;
      // eslint-disable-next-line no-await-in-loop
      await installment.save({ transaction });
    }
  }

  await registrarAuditoria(
    {
      groupId: commission.groupId,
      companyId: commission.companyId,
      actorUserId,
      action: 'finance.commission.cancel_adjustment',
      entityType: 'Commission',
      entityId: commission.id,
      beforeJson,
      afterJson: {
        commission: commission.toJSON(),
        adjustment: {
          adjustmentType: 'CANCELLATION_REVERSAL',
          paidAmountBefore,
          totalAmountBefore,
          adjustmentAmount,
        },
      },
      reason: `Comissão cancelada (contrato cancelado): ${reasonText}. Já pago/recebido ${paidAmountBefore} de ${totalAmountBefore} — ajuste de ${adjustmentAmount} sobre o saldo em aberto.`,
    },
    transaction
  );

  return {
    commission,
    adjustment: { adjustmentType: 'CANCELLATION_REVERSAL', paidAmountBefore, totalAmountBefore, adjustmentAmount },
  };
}

/**
 * getCommissionAdjustments — histórico de ajustes (cancelamentos) de uma comissão, lido do
 * rastro de auditoria append-only (ver nota de modelagem acima).
 */
async function getCommissionAdjustments(commissionId, transaction) {
  const logs = await AuditLog.findAll({
    where: { action: 'finance.commission.cancel_adjustment', entityType: 'Commission', entityId: commissionId },
    order: [['created_at', 'ASC']],
    transaction,
  });
  return logs.map((log) => (log.afterJson || {}).adjustment).filter(Boolean);
}

module.exports = {
  publishCommissionRuleVersion,
  listCommissionRuleVersions,
  getActiveCommissionRule,
  getCommissionRelease,
  RULE_CODE,
  COMPONENTS,
  createCommission,
  listCommissions,
  getCommission,
  listCommissionInstallments,
  markInstallmentPaid,
  cancelCommission,
  getCommissionAdjustments,
  STATUSES,
};
