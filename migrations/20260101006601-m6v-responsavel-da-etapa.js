'use strict';

/**
 * Verificação independente do Marco 6 (M6-19 e M6-81), Caderno Construção + Obras + Pós-obra §2: "Etapas possuem
 * dependências sem ciclos, prazo, progresso, custo e responsável." construction.project_stages ganha o responsável
 * (usuário). A aplicação confere que o usuário é membro ATIVO da mesma empresa (projectStages.service.js) e exige o
 * responsável para iniciar a etapa, como já exigia código, custo e datas. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE construction.project_stages
      ADD COLUMN IF NOT EXISTS responsible_user_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE RESTRICT`);
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS project_stages_responsible_idx ON construction.project_stages (company_id, responsible_user_id) WHERE responsible_user_id IS NOT NULL'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS construction.project_stages_responsible_idx');
    await queryInterface.sequelize.query('ALTER TABLE construction.project_stages DROP COLUMN IF EXISTS responsible_user_id');
  },
};
