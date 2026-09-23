'use strict';

require('dotenv').config();
const { sequelize } = require('../src/models');

// Concede ao papel ADMIN existente as permissões de CRM que ficaram fora da lista original de
// seed (scripts/seed-dev.js) — tasks, proposals, dashboard, feedback e export de oportunidades.
// Achado na auditoria adversarial de 23/09/2026: ADMIN tinha 74/84 permissões, bloqueando as
// telas de CRM Tarefas e Propostas com 403.
const MISSING = [
  'crm:tasks:create', 'crm:tasks:read',
  'crm:proposals:create', 'crm:proposals:read', 'crm:proposals:update',
  'crm:dashboard:read',
  'crm:feedback:create', 'crm:feedback:read', 'crm:feedback:update',
  'crm:opportunities:export',
];

(async () => {
  await sequelize.authenticate();
  const roles = await sequelize.query(
    "SELECT id, name FROM core.roles WHERE name = 'ADMIN'",
    { type: sequelize.QueryTypes.SELECT }
  );
  console.log('ADMIN roles found:', roles.length);
  for (const role of roles) {
    for (const code of MISSING) {
      const [perm] = await sequelize.query('SELECT id FROM core.permissions WHERE code = :code', {
        replacements: { code },
        type: sequelize.QueryTypes.SELECT,
      });
      if (!perm) {
        console.log('  MISSING PERMISSION ROW (not seeded):', code);
        continue;
      }
      const existing = await sequelize.query(
        'SELECT id FROM core.role_permissions WHERE role_id = :roleId AND permission_id = :permId',
        { replacements: { roleId: role.id, permId: perm.id }, type: sequelize.QueryTypes.SELECT }
      );
      if (existing.length) continue;
      await sequelize.query(
        'INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at) VALUES (gen_random_uuid(), :roleId, :permId, now(), now())',
        { replacements: { roleId: role.id, permId: perm.id } }
      );
      console.log('  granted', code, 'to role', role.id);
    }
  }
  await sequelize.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
