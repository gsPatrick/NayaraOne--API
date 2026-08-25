'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: popula "core"."permissions" com as strings "construction:*" usadas pelas rotas
 * do Marco 6 (Obras e Pós-obra) — mesmo padrão de 20260101000095-seed-remaining-permissions.js.
 */
const CODES = [
  ['construction:create', 'Criar obras, etapas, medições, RDOs, linhas de orçamento, itens de qualidade e chamados de pós-obra.', 'MEDIUM'],
  ['construction:read', 'Consultar obras, etapas, medições, RDOs, orçamento, qualidade e pós-obra.', 'LOW'],
  ['construction:update', 'Atualizar obras, etapas, RDOs, orçamento, checklist de qualidade e chamados de pós-obra.', 'MEDIUM'],
  ['construction:approve', 'Aprovar ou rejeitar medições de etapa de obra.', 'HIGH'],
  ['construction:delete', 'Excluir registros do módulo de obras.', 'HIGH'],
];

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
