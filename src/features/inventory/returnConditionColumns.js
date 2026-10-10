'use strict';

const { sequelize } = require('../../models');

// GAP 2 (fechamento de auditoria externa Nayara, Marco 6): "Conferência detalhada dos
// movimentos e custos de devolução" + "Reaproveitamento de materiais". A migration
// 20260101000303-add-return-condition-fields-to-inventory-movements.js cria
// "inventory"."inventory_movements".reusable/condition_code/return_cost, mas precisa de
// credencial de admin pra rodar (a credencial de runtime "nayara_runtime" não tem DDL sobre o
// schema `public`/catálogo — mesma limitação já documentada em
// construction/warrantyActionTeamMaterialColumns.js, inventory/minStockRules.service.js,
// models/ContractRequirement.js etc.) — NÃO foi aplicada ainda neste ambiente.
//
// Mesmo padrão: detecta, uma única vez por processo, se as colunas já existem. Até a migration
// rodar, a devolução grava reusable/conditionCode/returnCost de forma 100% funcional e
// consultável mesmo assim — via `registrarAuditoria` (tabela real "audit"."audit_log", já
// existente e aplicada, JSONB em afterJson) dentro de materialRequests.service.js#returnMaterialRequest
// — nunca falha silenciosamente nem perde o dado. Quando a migration rodar, este helper passa a
// também persistir as 3 colunas reais no próprio movimento, sem precisar de novo deploy.
let cachedExists = null;

async function columnsExist(transaction) {
  if (cachedExists !== null) return cachedExists;
  const [rows] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'inventory' AND table_name = 'inventory_movements'
       AND column_name IN ('reusable', 'condition_code', 'return_cost')`,
    { transaction }
  );
  cachedExists = rows.length === 3;
  return cachedExists;
}

async function setReturnCondition(movementId, { reusable, conditionCode, returnCost }, transaction) {
  if (!(await columnsExist(transaction))) return false;
  await sequelize.query(
    `UPDATE "inventory"."inventory_movements"
       SET reusable = :reusable, condition_code = :conditionCode, return_cost = :returnCost
     WHERE id = :id`,
    { replacements: { id: movementId, reusable: reusable == null ? null : reusable, conditionCode: conditionCode || null, returnCost: returnCost == null ? null : returnCost }, transaction }
  );
  return true;
}

async function getReturnConditionByMovementId(movementId, transaction) {
  if (!movementId || !(await columnsExist(transaction))) return null;
  const [rows] = await sequelize.query(
    `SELECT reusable, condition_code AS "conditionCode", return_cost AS "returnCost"
       FROM "inventory"."inventory_movements" WHERE id = :id`,
    { replacements: { id: movementId }, transaction }
  );
  return rows[0] || null;
}

module.exports = { columnsExist, setReturnCondition, getReturnConditionByMovementId };
