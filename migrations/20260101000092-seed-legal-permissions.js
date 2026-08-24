'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration: seed do catálogo "core"."permissions" com as strings "legal:*" usadas pelas
 * rotas do Marco 5 (Contratos, Billing/Garantias, Vistorias, Jurídico).
 *
 * DECISÃO DE ENGENHARIA: nenhuma migration existente popula "core"."permissions" — nem mesmo
 * o módulo finance semeia "finance:*" via migration/seeder (a tabela está vazia em todas as
 * migrations pré-existentes verificadas). Como o requisito pede explicitamente "se não
 * existirem, crie uma migration/seed nova... seguindo o padrão de seed já usado para
 * finance:*" e esse padrão de fato não existe ainda no repo, esta migration inaugura o
 * padrão de bulkInsert direto em core.permissions (abordagem mais simples e idempotente via
 * ON CONFLICT DO NOTHING em `code`, que é UNIQUE) — futuras seeds de finance:* podem replicar
 * este mesmo formato.
 */
const CODES = [
  ['legal:create', 'Criar contratos, versões, garantias, vistorias, entregas de chaves, processos e prazos jurídicos.', 'MEDIUM'],
  ['legal:read', 'Consultar contratos, garantias, vistorias, processos e prazos jurídicos.', 'LOW'],
  ['legal:update', 'Atualizar contratos, garantias, vistorias, processos e prazos jurídicos.', 'MEDIUM'],
  ['legal:sign', 'Iniciar/gerenciar o fluxo de assinatura eletrônica de contratos.', 'MEDIUM'],
  ['legal:approve', 'Aprovar transições de status de contratos (ex.: DRAFT -> LEGAL_REVIEW -> APPROVED).', 'HIGH'],
  ['legal:deliverKeys', 'Liberar a entrega de chaves de um imóvel locado.', 'MEDIUM'],
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

    // ON CONFLICT DO NOTHING: idempotente caso a migration seja reexecutada em ambiente onde
    // algum código já tenha sido inserido manualmente.
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
