'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration (Marco 3 — CRM): popula "core"."permissions" com as permissões das features novas
 * deste pacote. Mesmo padrão de 20260101000101-seed-audit-permissions.js.
 *
 *  - crm:proposals:*        — entidade real de Proposta (M3-13/M3-25).
 *  - crm:dashboard:read     — painel de indicadores calculado pela mesma fonte das listas (M3-17).
 *  - crm:feedback:*         — reclamações/elogios/conflitos com SLA e escalonamento (M3-20).
 *  - crm:opportunities:export — EXPORTAÇÃO SENSÍVEL (M3-21). Permissão DEDICADA e de risco
 *    HIGH: quem pode LER a lista de oportunidades na tela (crm:opportunities:read) NÃO pode
 *    automaticamente baixar a base inteira em CSV. Toda exportação grava auditoria
 *    `data.export` com a contagem de registros (ver opportunitiesExport.service.js).
 */
const CODES = [
  ['crm:proposals:create', 'Criar propostas (nova versão de proposta em uma oportunidade).', 'MEDIUM'],
  ['crm:proposals:read', 'Consultar propostas e seu histórico de versões.', 'LOW'],
  ['crm:proposals:update', 'Alterar o status de uma proposta (enviar, aceitar, recusar, expirar).', 'MEDIUM'],
  ['crm:dashboard:read', 'Consultar os indicadores do painel de CRM.', 'LOW'],
  ['crm:feedback:create', 'Registrar reclamações, elogios e conflitos de clientes.', 'LOW'],
  ['crm:feedback:read', 'Consultar reclamações, elogios e conflitos de clientes.', 'LOW'],
  ['crm:feedback:update', 'Resolver ou escalonar reclamações, elogios e conflitos.', 'MEDIUM'],
  ['crm:opportunities:export', 'Exportar a base de oportunidades (exportação sensível, sempre auditada).', 'HIGH'],
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
