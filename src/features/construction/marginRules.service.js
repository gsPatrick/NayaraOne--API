'use strict';

const { MarginRule } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// DECISÃO DE ENGENHARIA (ver migração 20260101000181): margem mínima de obra é versionada
// nesta tabela dedicada, não no Motor de Regras genérico (core.rules) — o motor genérico
// ainda não modela o domínio "margem de obra". Cada linha é uma versão imutável; criar uma
// nova versão desativa a anterior, mas a anterior permanece intacta no histórico (nunca é
// editada nem apagada), preservando `rule_version_id` de orçamentos já aprovados com ela.

async function createMarginRule(payload, actorUserId, transaction) {
  const { groupId, companyId, minMarginPct, description } = payload;
  if (!groupId || !companyId || minMarginPct === undefined || minMarginPct === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId" e "minMarginPct" são obrigatórios.',
      'MARGIN_RULE_VALIDATION'
    );
  }
  const numeric = Number(minMarginPct);
  if (Number.isNaN(numeric) || numeric < 0) {
    throw AppError.badRequest('"minMarginPct" deve ser um percentual numérico não negativo.', 'MARGIN_RULE_VALIDATION');
  }

  // Desativa a versão ativa anterior (se houver) ANTES de criar a nova — nunca duas versões
  // ativas simultâneas para a mesma empresa (reforçado também pelo índice único parcial da
  // migração).
  await MarginRule.update(
    { isActive: false, updatedBy: actorUserId || null },
    { where: { groupId, companyId, isActive: true }, transaction }
  );

  const rule = await MarginRule.create(
    {
      groupId,
      companyId,
      minMarginPct: numeric,
      description: description || null,
      isActive: true,
      createdBy: actorUserId || null,
      updatedBy: actorUserId || null,
    },
    { transaction }
  );

  await registrarAuditoria(
    {
      groupId,
      companyId,
      actorUserId,
      action: 'construction.margin_rule.create',
      entityType: 'MarginRule',
      entityId: rule.id,
      afterJson: rule.toJSON(),
      reason: `Nova versão de margem mínima criada (${numeric}%).`,
    },
    transaction
  );

  return rule;
}

async function getActiveMarginRule(groupId, companyId, transaction) {
  const rule = await MarginRule.findOne({ where: { groupId, companyId, isActive: true }, transaction });
  if (!rule) {
    throw AppError.unprocessable(
      'Não há margem mínima configurada para esta empresa — configure uma versão de regra antes de aprovar orçamento.',
      'MARGIN_RULE_NOT_CONFIGURED'
    );
  }
  return rule;
}

async function getMarginRule(id, transaction) {
  const rule = await MarginRule.findByPk(id, { transaction, paranoid: false });
  if (!rule) throw AppError.notFound('Regra de margem não encontrada.', 'MARGIN_RULE_NOT_FOUND');
  return rule;
}

module.exports = { createMarginRule, getActiveMarginRule, getMarginRule };
