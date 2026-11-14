'use strict';

const { forceRestaurado } = require('../src/shared/db/forceRestaurado');
const { randomUUID } = require('crypto');

/**
 * Permissão específica para vincular a esta empresa uma pessoa já cadastrada em outra empresa do grupo e para desfazer o
 * vínculo (DI-M9I-4): `people:link`, risco HIGH, concedida ao papel ADMIN (mesmo padrão de legal:evidence:export, migration
 * 20260101009999). Quem só tem people:create continua cadastrando pessoas novas; o vínculo exige esta permissão.
 *
 * Também cria o índice parcial que a API usa para contar, por usuário e janela, as tentativas de vínculo que não conferiram
 * e os CPF/CNPJ recusados por já existirem no grupo (limite configurável, DI-M9I-5): sem ele, a contagem varreria toda a
 * trilha de auditoria da empresa.
 */
const CODE = 'people:link';
const ACOES = "('people.person.link_attempt')";

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const now = new Date();
    await queryInterface.bulkInsert(
      { tableName: 'permissions', schema: 'core' },
      [{ id: randomUUID(), code: CODE, description: 'Vincular a esta empresa uma pessoa já cadastrada em outra empresa do grupo (pelo CPF/CNPJ e o nome) e desfazer o vínculo.', risk_level: 'HIGH', created_at: now, updated_at: now }],
      { ignoreDuplicates: true }
    );
    await sequelize.query('ALTER TABLE core.companies NO FORCE ROW LEVEL SECURITY');
    await sequelize.query('ALTER TABLE core.roles NO FORCE ROW LEVEL SECURITY');
    await forceRestaurado(async () => {
      await sequelize.query(`
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
        FROM core.roles r CROSS JOIN core.permissions p
        WHERE r.name = 'ADMIN' AND p.code = :code
          AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)
      `, { replacements: { code: CODE } });
    }, async () => {
      await sequelize.query('ALTER TABLE core.companies FORCE ROW LEVEL SECURITY');
      await sequelize.query('ALTER TABLE core.roles FORCE ROW LEVEL SECURITY');
    });
    await sequelize.query(`CREATE INDEX IF NOT EXISTS audit_log_people_link_attempt_idx ON audit.audit_log (company_id, user_id, occurred_at)
      WHERE action IN ${ACOES}`);
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query('DROP INDEX IF EXISTS audit.audit_log_people_link_attempt_idx');
    await sequelize.query('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code = :code)', { replacements: { code: CODE } });
    await sequelize.query('DELETE FROM core.permissions WHERE code = :code', { replacements: { code: CODE } });
  },
};
