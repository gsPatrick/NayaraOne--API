'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: popula "core"."permissions" com "audit:read", usada pela nova rota GET
 * /audit-log (feature audit — tela "Atividades" do front). Mesmo padrão de
 * 20260101000100-seed-construction-permissions.js.
 *
 * Não existe "audit:*" write/delete — audit_log é append-only, sem endpoint de edição. As
 * ações de "cancelar"/"bloquear" que a tela de Atividades oferece usam as permissões que já
 * existem nos domínios donos do registro (finance:*, legal:approve, users:update) — não
 * criam permissão nova.
 */
const CODES = [['audit:read', 'Consultar a trilha de auditoria (quem fez o quê e quando).', 'MEDIUM']];

module.exports = {
  up: async (queryInterface) => {
    const now = new Date();
    const rows = CODES.map(([code, description, riskLevel]) => ({
      id: randomUUID(),
      code,
      description,
      risk_level: riskLevel,
      created_at: now,
      updated_at: now,
    }));

    await queryInterface.bulkInsert({ tableName: 'permissions', schema: 'core' }, rows, {
      ignoreDuplicates: true,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.bulkDelete(
      { tableName: 'permissions', schema: 'core' },
      { code: CODES.map(([code]) => code) }
    );
  },
};
