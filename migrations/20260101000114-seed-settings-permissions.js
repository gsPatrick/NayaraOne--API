'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: popula "core"."permissions" com o grupo "settings:*", usado pelas rotas novas de
 * src/features/settings (painel admin de configuração por tenant). Mesmo padrão de
 * 20260101000112-seed-billing-permissions.js.
 *
 * DECISÃO DE ENGENHARIA — o Caderno não especifica granularidade de permissão para o painel
 * de configurações; seguimos o mesmo padrão read/update usado pelas demais features
 * administrativas (ex.: groups/companies), com "update" cobrindo tanto criar quanto alterar
 * uma configuração (upsert por chave), já que não há um "criar" distinto de "atualizar" nesse
 * domínio (uma tenant_setting é sempre um upsert por company_id+key).
 */
const CODES = [
  ['settings:read', 'Consultar configurações por empresa (painel admin de settings).', 'LOW'],
  ['settings:update', 'Criar/atualizar configurações por empresa (painel admin de settings).', 'HIGH'],
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
