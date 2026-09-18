'use strict';

const { sequelize, IntercompanyTransfer, Company } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');
const { createFinancialEntry } = require('./financialEntries.service');

// M4-18 — Transferências formais entre empresas do mesmo grupo.
//
// Antes disso, mover dinheiro entre empresas do grupo era feito criando dois lançamentos soltos
// "na mão", sem nada ligando um ao outro: se alguém criasse só a saída e esquecesse a entrada,
// nada no sistema acusava. Aqui a transferência é um ÚNICO ato: os dois lançamentos (DEBIT na
// origem, CREDIT no destino, ambos nature=ADJUSTMENT) nascem na MESMA transação do registro de
// transferência. Não existe transferência com uma perna só.
//
// DECISÃO DE RLS (ver também a migration 20260101000134): a linha de transferência pertence à
// empresa de ORIGEM (`company_id = from_company_id`, garantido por CHECK no banco). A policy
// `tenant_isolation` é a mesma de todo o resto do projeto — uma coluna, uma comparação. A
// empresa de destino não enxerga a linha de transferência, só o lançamento de crédito dela,
// que vive sob o RLS dela própria.
//
// COMO O LANÇAMENTO DO DESTINO É CRIADO: `finance.financial_entries` tem RLS FORÇADO com a
// policy USING (sem WITH CHECK explícito — o Postgres então aplica o USING também no INSERT).
// Inserir uma linha com company_id da empresa de destino enquanto app.company_id aponta para a
// origem seria REJEITADO pelo próprio banco. Por isso trocamos app.company_id via SET LOCAL
// para a empresa de destino só durante a criação daquele lançamento e restauramos em seguida,
// tudo dentro da mesma transação. Isso NÃO é um bypass de RLS: continuamos sujeitos à policy,
// apenas assumimos explicitamente (e de forma auditada) o contexto da empresa para a qual o
// operador tem autorização de transferir dentro do mesmo grupo.

const TRANSFER_STATUSES = ['PENDING', 'RECONCILED'];

async function setCompanyContext(companyId, transaction) {
  await sequelize.query('SET LOCAL app.company_id = :companyId', { replacements: { companyId }, transaction });
}

async function getIntercompanyTransfer(id, transaction) {
  const transfer = await IntercompanyTransfer.findByPk(id, { transaction });
  if (!transfer) {
    throw AppError.notFound('Transferência entre empresas não encontrada.', 'FINANCE_INTERCOMPANY_NOT_FOUND');
  }
  return transfer;
}

async function createIntercompanyTransfer(payload, actorUserId, transaction) {
  const { groupId, companyId, toCompanyId, amount, reason, dueAt } = payload;
  // `companyId` vem do contexto de tenant (withTenant no controller) e É a empresa de origem.
  const fromCompanyId = payload.fromCompanyId || companyId;

  if (!groupId || !fromCompanyId || !toCompanyId || amount === undefined || amount === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "fromCompanyId" (ou o contexto da empresa atual), "toCompanyId" e "amount" são obrigatórios.',
      'FINANCE_INTERCOMPANY_VALIDATION'
    );
  }
  if (fromCompanyId !== companyId) {
    throw AppError.forbidden(
      'A transferência só pode ser originada pela empresa do contexto atual — troque de empresa para transferir a partir dela.',
      'FINANCE_INTERCOMPANY_ORIGIN_MISMATCH'
    );
  }
  if (fromCompanyId === toCompanyId) {
    throw AppError.badRequest('A empresa de origem e a de destino precisam ser diferentes.', 'FINANCE_INTERCOMPANY_SAME_COMPANY');
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw AppError.badRequest('O campo "amount" deve ser um número positivo.', 'FINANCE_INTERCOMPANY_VALIDATION');
  }

  // A empresa de destino precisa ser do MESMO grupo — "intercompany" é entre empresas do grupo,
  // nunca uma saída de dinheiro para um tenant estranho. core.companies tem RLS por grupo, então
  // esta leitura já está restrita ao grupo do contexto; a checagem explícita de groupId fecha o caso.
  const destination = await Company.findByPk(toCompanyId, { transaction });
  if (!destination || destination.groupId !== groupId) {
    throw AppError.badRequest(
      'A empresa de destino não existe ou não pertence a este grupo.',
      'FINANCE_INTERCOMPANY_DESTINATION_INVALID'
    );
  }

  const description = reason
    ? `Transferência entre empresas: ${String(reason).trim()}`
    : 'Transferência entre empresas do grupo';

  // Perna 1 — saída na origem (contexto de tenant atual, sem troca de company_id).
  const fromEntry = await createFinancialEntry(
    {
      groupId,
      companyId: fromCompanyId,
      entryType: 'DEBIT',
      nature: 'ADJUSTMENT',
      amount: numericAmount,
      description,
      dueAt: dueAt || null,
    },
    actorUserId,
    transaction
  );

  // Perna 2 — entrada no destino. Assume o contexto da empresa de destino só para este INSERT
  // (ver nota de RLS no topo) e restaura o contexto original logo em seguida, ainda dentro da
  // mesma transação — qualquer falha aqui desfaz a perna 1 junto.
  let toEntry;
  try {
    await setCompanyContext(toCompanyId, transaction);
    toEntry = await createFinancialEntry(
      {
        groupId,
        companyId: toCompanyId,
        entryType: 'CREDIT',
        nature: 'ADJUSTMENT',
        amount: numericAmount,
        description,
        dueAt: dueAt || null,
      },
      actorUserId,
      transaction
    );
  } finally {
    await setCompanyContext(fromCompanyId, transaction);
  }

  const transfer = await IntercompanyTransfer.create(
    {
      groupId,
      companyId: fromCompanyId,
      fromCompanyId,
      toCompanyId,
      amount: numericAmount,
      reason: reason ? String(reason).trim() : null,
      status: 'PENDING',
      fromEntryId: fromEntry.id,
      toEntryId: toEntry.id,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId: fromCompanyId,
      actorUserId,
      action: 'finance.intercompany_transfer.create',
      entityType: 'IntercompanyTransfer',
      entityId: transfer.id,
      afterJson: { transfer: transfer.toJSON(), fromEntryId: fromEntry.id, toEntryId: toEntry.id },
      reason: `Transferência de ${numericAmount} da empresa ${fromCompanyId} para ${toCompanyId} — lançamentos ${fromEntry.id} (saída) e ${toEntry.id} (entrada) criados na mesma transação.`,
    },
    transaction
  );

  return { transfer, fromEntry, toEntry };
}

async function listIntercompanyTransfers(transaction, filters = {}) {
  const where = {};
  if (filters.status) where.status = String(filters.status).toUpperCase();
  if (filters.toCompanyId) where.toCompanyId = filters.toCompanyId;
  return IntercompanyTransfer.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

/**
 * reconcileIntercompanyTransfer — marca a transferência como RECONCILED quando a entrada foi
 * de fato confirmada na empresa de destino. Não mexe em valor de lançamento nenhum (ledger
 * imutável, FIN-003): só muda o status do registro de controle da transferência.
 */
async function reconcileIntercompanyTransfer(id, actorUserId, transaction) {
  const transfer = await getIntercompanyTransfer(id, transaction);
  if (transfer.status === 'RECONCILED') {
    throw AppError.conflict('Esta transferência já foi conciliada.', 'FINANCE_INTERCOMPANY_ALREADY_RECONCILED');
  }
  const beforeJson = transfer.toJSON();
  transfer.status = 'RECONCILED';
  transfer.reconciledAt = new Date();
  transfer.reconciledByUserId = actorUserId || null;
  transfer.updatedBy = actorUserId || null;
  await transfer.save({ transaction });

  await registrarAuditoria(
    {
      groupId: transfer.groupId,
      companyId: transfer.companyId,
      actorUserId,
      action: 'finance.intercompany_transfer.reconcile',
      entityType: 'IntercompanyTransfer',
      entityId: transfer.id,
      beforeJson,
      afterJson: transfer.toJSON(),
      reason: `Transferência entre empresas de ${transfer.amount} conciliada (entrada confirmada no destino).`,
    },
    transaction
  );

  return transfer;
}

module.exports = {
  createIntercompanyTransfer,
  listIntercompanyTransfers,
  getIntercompanyTransfer,
  reconcileIntercompanyTransfer,
  TRANSFER_STATUSES,
};
