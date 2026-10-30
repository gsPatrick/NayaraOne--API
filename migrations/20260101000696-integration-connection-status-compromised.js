'use strict';

/**
 * M9-D433 — conta comprometida: o status da conexão de integração ganha COMPROMISED. Marca a conexão cujo token foi revogado por suspeita de comprometimento; ela não
 * volta a ACTIVE sem nova credencial no cofre (regra em connections.transition). Só amplia a lista permitida do CHECK de status; nenhuma linha muda.
 */
const TABLE = '"integration"."connections"';

async function recreateCheck(queryInterface, statuses) {
  const sequelize = queryInterface.sequelize;
  await sequelize.transaction(async (transaction) => {
    const [rows] = await sequelize.query(
      `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'integration' AND t.relname = 'connections' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%AUTH_FAILED%' AND pg_get_constraintdef(c.oid) LIKE '%DRAFT%'`,
      { transaction }
    );
    for (const row of rows) await sequelize.query(`ALTER TABLE ${TABLE} DROP CONSTRAINT "${row.conname}"`, { transaction });
    const list = statuses.map((s) => `'${s}'`).join(', ');
    await sequelize.query(`ALTER TABLE ${TABLE} ADD CONSTRAINT connections_status_check CHECK (status IN (${list}))`, { transaction });
  });
}

module.exports = {
  async up(queryInterface) {
    await recreateCheck(queryInterface, ['DRAFT', 'ACTIVE', 'PAUSED', 'AUTH_FAILED', 'COMPROMISED', 'DISABLED']);
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query(`UPDATE ${TABLE} SET status = 'DISABLED' WHERE status = 'COMPROMISED'`);
    await recreateCheck(queryInterface, ['DRAFT', 'ACTIVE', 'PAUSED', 'AUTH_FAILED', 'DISABLED']);
  },
};
