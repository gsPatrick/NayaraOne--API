'use strict';

/**
 * Concede ao(s) papel(is) chamado(s) "ADMIN" as permissões de CRM que ficaram fora da lista
 * original de seed (scripts/seed-dev.js) — tasks, proposals, dashboard, feedback e export de
 * oportunidades. Achado na auditoria adversarial de 23/09/2026: o papel ADMIN existente no
 * tenant de homologação tinha 74/84 permissões, bloqueando com 403 as telas de CRM
 * Tarefas/Propostas mesmo sendo o papel administrativo. Idempotente (ON CONFLICT DO NOTHING) —
 * seguro rodar mais de uma vez ou em qualquer ambiente que já tenha essas permissões concedidas.
 */
const CODES = [
  'crm:tasks:create',
  'crm:tasks:read',
  'crm:proposals:create',
  'crm:proposals:read',
  'crm:proposals:update',
  'crm:dashboard:read',
  'crm:feedback:create',
  'crm:feedback:read',
  'crm:feedback:update',
  'crm:opportunities:export',
];

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `
      INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
      SELECT gen_random_uuid(), r.id, p.id, now(), now()
      FROM core.roles r
      CROSS JOIN core.permissions p
      WHERE r.name = 'ADMIN'
        AND p.code = ANY(ARRAY[:codes])
        AND NOT EXISTS (
          SELECT 1 FROM core.role_permissions rp
          WHERE rp.role_id = r.id AND rp.permission_id = p.id
        )
      `,
      { replacements: { codes: CODES } }
    );
  },

  down: async () => {
    // Concessão de permissão pré-existente não é revertida automaticamente — reverter exigiria
    // saber se a permissão já estava lá antes desta migration, o que não é rastreável aqui.
  },
};
