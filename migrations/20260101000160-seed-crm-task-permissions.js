'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration (Marco 3 — CRM / M3-11): permissões das tarefas de oportunidade.
 *
 * A tabela "core"."tasks" já existe desde 20260101000009 (com RLS real), então aqui não há
 * DDL — só as permissões das rotas novas POST/GET /crm/opportunities/:id/tasks. Permissões
 * DEDICADAS (crm:tasks:*) em vez de reaproveitar crm:opportunities:update: atribuir trabalho
 * a outra pessoa é um ato diferente de editar o funil.
 */
const CODES = [
  ['crm:tasks:create', 'Criar tarefas vinculadas a uma oportunidade de CRM.', 'LOW'],
  ['crm:tasks:read', 'Consultar as tarefas de uma oportunidade de CRM.', 'LOW'],
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
