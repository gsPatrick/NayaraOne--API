'use strict';

const { randomUUID } = require('crypto');

/**
 * Marco 9, M9-D200 (reabertura M1) — permissão integration:platform: escrever no catálogo GLOBAL de fornecedores
 * (integration.providers), que vale para todas as empresas. Diferente de integration:manage (conexões da própria empresa),
 * esta NÃO é concedida a nenhum papel por padrão (nem ao ADMIN da empresa): a equipe da plataforma a concede a um papel
 * próprio. Só cria a permissão.
 */
const DESCRICAO = 'Administrar o catálogo global de fornecedores de integração (vale para todas as empresas). Exclusiva da equipe da plataforma.';

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      `INSERT INTO core.permissions (id, code, description, risk_level, created_at, updated_at)
       SELECT :id, 'integration:platform', :descricao, 'HIGH', now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM core.permissions WHERE code = 'integration:platform')`,
      { replacements: { id: randomUUID(), descricao: DESCRICAO } }
    );
  },
  down: async () => {},
};
