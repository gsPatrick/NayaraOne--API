'use strict';

/**
 * Migration (EXPAND — 01_ARQUITETURA_E_INVARIANTES.md §2.11): adiciona "role_id" (nullable)
 * a "core"."user_memberships", vinculando o vínculo user/company/unit a um papel RBAC de
 * "core"."roles". Nullable para não quebrar linhas existentes (compat); aplicação deve
 * exigir o preenchimento na camada de validação da feature de memberships.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn(
      { tableName: 'user_memberships', schema: 'core' },
      'role_id',
      {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: { tableName: 'roles', schema: 'core' }, key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
      }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn({ tableName: 'user_memberships', schema: 'core' }, 'role_id');
  },
};
