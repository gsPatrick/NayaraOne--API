'use strict';

const { randomUUID } = require('crypto');

/**
 * Migration (Marco 3 — CRM-TS-012 / item 17 do Caderno, seção 18 "Antifraude e segurança":
 * "Corretor visualizar carteira alheia — Escopo conforme política de equipe").
 *
 * Sem DDL — "core"."permissions" já existe, só duas novas linhas de catálogo:
 *   - crm:opportunities:read:own  — vê só as oportunidades onde é responsibleUserId/ownerUserId.
 *   - crm:opportunities:read:all  — vê todas as oportunidades da empresa (gestor/admin).
 *
 * `crm:opportunities:read` (a permissão antiga, que continua controlando o acesso à ROTA)
 * não muda de significado sozinha: ver src/features/crm/opportunity.service.js
 * (`applyOwnerScope`) para o fallback — usuário sem NENHUMA das duas novas permissões de
 * escopo continua vendo tudo (sem regressão de acesso), até a empresa migrar os papéis
 * existentes para usar o escopo granular.
 */
const CODES = [
  [
    'crm:opportunities:read:own',
    'Ver apenas as oportunidades de CRM das quais é responsável (escopo "minha carteira").',
    'LOW',
  ],
  [
    'crm:opportunities:read:all',
    'Ver todas as oportunidades de CRM da empresa, independente do responsável (escopo gestor).',
    'LOW',
  ],
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
