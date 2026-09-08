'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: popula "core"."permissions" com o grupo "billing:*", usado pelas rotas novas de
 * src/features/billing (Marco 5, M07 Billing Locação/Utilities). Mesmo padrão de
 * 20260101000100-seed-construction-permissions.js / 20260101000101-seed-audit-permissions.js.
 *
 * DECISÃO DE ENGENHARIA — o Caderno não especifica a lista de permissões granulares do módulo;
 * seguimos o padrão já usado por finance/legal (create/read/update/approve), com "approve"
 * reservado para ações que mexem em dinheiro real (pagar aluguel garantido, aprovar
 * antecipação) e "update" para as demais mutações operacionais (gerar cobrança, registrar
 * reajuste, gerenciar utilidades, closeout).
 */
const CODES = [
  ['billing:create', 'Criar registros de billing de locação (cronograma, reajuste, utilidade, antecipação).', 'MEDIUM'],
  ['billing:read', 'Consultar dados de billing de locação.', 'LOW'],
  ['billing:update', 'Atualizar registros de billing de locação (acordos, utilidades, closeout).', 'MEDIUM'],
  ['billing:approve', 'Aprovar/pagar movimentações financeiras de billing (aluguel garantido, antecipação de aluguel).', 'HIGH'],
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
