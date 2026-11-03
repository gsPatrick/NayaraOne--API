'use strict';

const { sequelize } = require('../../models');

// GAP CORRIGIDO (auditoria pós-Marco 6, item 2): "equipe/material específico de ação de
// garantia não tem campo dedicado no schema atual". A migration 20260101000296 cria
// `construction.warranty_actions.assigned_team`/`material_used`, mas precisa de credencial de
// admin pra rodar (a credencial de runtime não tem DDL) — NÃO foi aplicada ainda neste
// ambiente. Este helper detecta, uma única vez por processo, se as colunas já existem; até lá,
// leitura/escrita dessas duas colunas simplesmente não acontece (fail-open, documentado, nunca
// quebra o módulo de garantia que já funcionava). Assim que a migration rodar, funciona sem
// precisar de novo deploy.
let cachedExists = null;

async function columnsExist(transaction) {
  if (cachedExists !== null) return cachedExists;
  const [rows] = await sequelize.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'construction' AND table_name = 'warranty_actions'
       AND column_name IN ('assigned_team', 'material_used')`,
    { transaction }
  );
  cachedExists = rows.length === 2;
  return cachedExists;
}

async function setTeamAndMaterial(warrantyActionId, assignedTeam, materialUsed, transaction) {
  if (!assignedTeam && !materialUsed) return;
  if (!(await columnsExist(transaction))) return;
  await sequelize.query(
    `UPDATE construction.warranty_actions SET assigned_team = :assignedTeam, material_used = :materialUsed WHERE id = :id`,
    { replacements: { id: warrantyActionId, assignedTeam: assignedTeam || null, materialUsed: materialUsed || null }, transaction }
  );
}

async function getTeamAndMaterialByActionIds(actionIds, transaction) {
  if (!actionIds.length || !(await columnsExist(transaction))) return new Map();
  const [rows] = await sequelize.query(
    `SELECT id, assigned_team AS "assignedTeam", material_used AS "materialUsed"
     FROM construction.warranty_actions WHERE id IN (:ids)`,
    { replacements: { ids: actionIds }, transaction }
  );
  return new Map(rows.map((r) => [r.id, { assignedTeam: r.assignedTeam, materialUsed: r.materialUsed }]));
}

module.exports = { columnsExist, setTeamAndMaterial, getTeamAndMaterialByActionIds };
