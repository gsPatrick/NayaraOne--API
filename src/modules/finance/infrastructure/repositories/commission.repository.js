'use strict';

// Repositório da COMISSÃO: todo acesso a dados de commission.service.js (comissões, parcelas,
// regra REG-FIN-002 no Motor de Regras, lançamento de origem e trilha de ajustes). As consultas
// e travas são as mesmas do serviço; cada função recebe a `transaction`.

const { Commission, CommissionInstallment, FinancialEntry, AuditLog, Rule, RuleVersion, RuleScope, RulePublication, sequelize } = require('../../../../models');

// --- Regra de comissão (Motor de Regras) -------------------------------------------------------

async function lockCommissionRule(lockKey, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', { replacements: { lockKey }, transaction });
}

function findRuleByCode(code, groupId, companyId, transaction) {
  return Rule.findOne({ where: { code, groupId, companyId }, transaction });
}

function createRule(values, transaction) {
  return Rule.create(values, { transaction });
}

function findCurrentPublishedRuleVersion(ruleId, transaction) {
  return RuleVersion.findOne({ where: { ruleId, status: 'PUBLISHED', effectiveUntil: null }, order: [['versionNumber', 'DESC']], transaction });
}

function closeCurrentRuleVersions(ruleId, values, transaction) {
  return RuleVersion.update(
    values,
    { where: { ruleId, status: 'PUBLISHED', effectiveUntil: null }, transaction }
  );
}

function findLastRuleVersion(ruleId, transaction) {
  return RuleVersion.findOne({ where: { ruleId }, order: [['versionNumber', 'DESC']], transaction });
}

function createRuleVersion(values, transaction) {
  return RuleVersion.create(values, { transaction });
}

function createRuleScope(values, transaction) {
  return RuleScope.create(values, { transaction });
}

function createRulePublication(values, transaction) {
  return RulePublication.create(values, { transaction });
}

function findRuleVersionSummary(ruleVersionId, transaction) {
  return RuleVersion.findByPk(ruleVersionId, { attributes: ['versionNumber', 'effectiveFrom'], transaction });
}

function listRuleVersions(ruleId, transaction) {
  return RuleVersion.findAll({ where: { ruleId }, order: [['versionNumber', 'DESC']], transaction });
}

function findUsersByIds(ids, transaction) {
  // require preguiçoso, como no serviço original.
  const { User } = require('../../../../models');
  return User.findAll({ where: { id: ids }, attributes: ['id', 'name', 'email'], transaction });
}

// --- Comissão ------------------------------------------------------------------------------------

function findCommissionByIdempotencyKey(companyId, idempotencyKey, transaction) {
  return Commission.findOne({ where: { companyId, idempotencyKey }, transaction });
}

function findActiveCommissionForFact({ companyId, sourceEntryId, component, beneficiaryUserId }, transaction) {
  return Commission.findOne({
    where: { companyId, sourceEntryId, component, beneficiaryUserId, status: ['PENDING', 'APPROVED', 'PAID'] },
    transaction,
  });
}

function createCommission(values, transaction) {
  return Commission.create(values, { transaction });
}

function listCommissions(where, transaction) {
  return Commission.findAll({ where, order: [['created_at', 'DESC']], transaction });
}

function findCommissionById(id, transaction) {
  return Commission.findByPk(id, { transaction });
}

function findCommissionByIdForUpdate(id, transaction) {
  return Commission.findByPk(id, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
}

// --- Parcelas ------------------------------------------------------------------------------------

function createInstallment(values, transaction) {
  return CommissionInstallment.create(values, { transaction });
}

function findInstallmentsByCommission(commissionId, transaction) {
  return CommissionInstallment.findAll({ where: { commissionId }, transaction });
}

function listInstallmentsOrdered(commissionId, transaction) {
  return CommissionInstallment.findAll({ where: { commissionId }, order: [['installment_number', 'ASC']], transaction });
}

function listInstallmentsForCommissions(ids, transaction) {
  return CommissionInstallment.findAll({ where: { commissionId: ids }, order: [['installment_number', 'ASC']], transaction });
}

function findInstallmentByIdForUpdate(installmentId, transaction) {
  return CommissionInstallment.findByPk(installmentId, { transaction, lock: transaction ? transaction.LOCK.UPDATE : undefined });
}

function findInstallmentByFinancialEntry(financialEntryId, transaction) {
  return CommissionInstallment.findOne({
    where: { financialEntryId },
    transaction,
  });
}

// --- Lançamento financeiro (fato gerador e baixa) -----------------------------------------------

function findCompanyEntryForUpdate(id, companyId, transaction) {
  return FinancialEntry.findOne({
    where: { id, companyId },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
}

function findEntryById(id, transaction) {
  return FinancialEntry.findByPk(id, { transaction });
}

// --- Ajustes (trilha de auditoria append-only) ---------------------------------------------------

function listCancellationAdjustmentLogs(commissionId, transaction) {
  return AuditLog.findAll({
    where: { action: 'finance.commission.cancel_adjustment', entityType: 'Commission', entityId: commissionId },
    order: [['created_at', 'ASC']],
    transaction,
  });
}

// --- Persistência de instância alterada pelo serviço ---------------------------------------------

function save(instance, transaction) {
  return instance.save({ transaction });
}

module.exports = {
  lockCommissionRule,
  findRuleByCode,
  createRule,
  findCurrentPublishedRuleVersion,
  closeCurrentRuleVersions,
  findLastRuleVersion,
  createRuleVersion,
  createRuleScope,
  createRulePublication,
  findRuleVersionSummary,
  listRuleVersions,
  findUsersByIds,
  findCommissionByIdempotencyKey,
  findActiveCommissionForFact,
  createCommission,
  listCommissions,
  findCommissionById,
  findCommissionByIdForUpdate,
  createInstallment,
  findInstallmentsByCommission,
  listInstallmentsOrdered,
  listInstallmentsForCommissions,
  findInstallmentByIdForUpdate,
  findInstallmentByFinancialEntry,
  findCompanyEntryForUpdate,
  findEntryById,
  listCancellationAdjustmentLogs,
  save,
};
