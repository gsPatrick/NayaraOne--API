'use strict';

const { MarginRule, sequelize } = require('../../models');
const AppError = require('../../utils/AppError');
const { registrarAuditoria } = require('../../engines/audit/auditLog.service');

// DECISÃO DE ENGENHARIA (ver migração 20260101000181): margem mínima de obra é versionada
// nesta tabela dedicada, não no Motor de Regras genérico (core.rules) — o motor genérico
// ainda não modela o domínio "margem de obra". Cada linha é uma versão imutável; criar uma
// nova versão desativa a anterior, mas a anterior permanece intacta no histórico (nunca é
// editada nem apagada), preservando `rule_version_id` de orçamentos já aprovados com ela.

/**
 * BUG REAL CORRIGIDO (30/09/2026, achado sob carga de teste concorrente pesada): o par
 * UPDATE (desativa versão anterior) + INSERT (nova versão ativa) sob o índice único parcial
 * `company_id WHERE is_active` pode formar um ciclo de deadlock (`40P01`) sob concorrência real
 * da mesma empresa. Mesma correção de `projects.service.js#generateProjectCode`:
 * `pg_advisory_xact_lock` serializa o acesso a esta chave lógica (groupId+companyId) ANTES do
 * UPDATE+INSERT — elimina a possibilidade de deadlock por completo (não é retry-e-espera-dar-
 * certo, é impedir duas transações de disputarem a mesma linha ao mesmo tempo).
 */
async function createMarginRuleAttempt(groupId, companyId, numeric, description, actorUserId, transaction) {
  const lockKey = `margin_rule:${groupId}:${companyId}`;
  await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))', {
    replacements: { lockKey },
    transaction,
  });

  await MarginRule.update(
    { isActive: false, updatedBy: actorUserId || null },
    { where: { groupId, companyId, isActive: true }, transaction }
  );
  return MarginRule.create(
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
}

async function createMarginRule(payload, actorUserId, transaction) {
  const { groupId, companyId, minMarginPct, description } = payload;
  if (!groupId || !companyId || minMarginPct === undefined || minMarginPct === null) {
    throw AppError.badRequest(
      'Os campos "groupId", "companyId" e "minMarginPct" são obrigatórios.',
      'MARGIN_RULE_VALIDATION'
    );
  }
  const numeric = Number(minMarginPct);
  // FIX (auditoria E2E de browser, ciclo 2, 01/10/2026): coluna min_margin_pct é
  // DECIMAL(5,2) (máx 999.99) — sem este limite, um valor maior (ex.: campo de edição não
  // limpo antes de digitar, concatenando "15" + "10,00" = 1510) estourava "numeric field
  // overflow" cru do Postgres direto na tela do usuário. Também não faz sentido uma margem
  // mínima >= 100% (custo zero ou negativo), então o limite de negócio é 100, bem abaixo do
  // limite físico da coluna.
  if (Number.isNaN(numeric) || numeric < 0 || numeric > 100) {
    throw AppError.badRequest('"minMarginPct" deve ser um percentual numérico entre 0 e 100.', 'MARGIN_RULE_VALIDATION');
  }

  // Desativa a versão ativa anterior (se houver) ANTES de criar a nova — nunca duas versões
  // ativas simultâneas para a mesma empresa (reforçado também pelo índice único parcial da
  // migração).
  const rule = await createMarginRuleAttempt(groupId, companyId, numeric, description, actorUserId, transaction);

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
