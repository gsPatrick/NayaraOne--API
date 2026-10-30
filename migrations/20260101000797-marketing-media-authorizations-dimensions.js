'use strict';

/**
 * M9-D428 — medidas da mídia autorizada. O servidor não examina o arquivo de vídeo ou imagem: quem autoriza a mídia informa largura, altura e (vídeo) duração, e o
 * agendamento confere essas medidas contra as capabilities da rede (proporção, duração). As três colunas são opcionais; largura e altura vêm juntas.
 * Idempotente, numa transação. O down só remove as colunas se nenhuma estiver preenchida.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('ALTER TABLE marketing.media_authorizations ADD COLUMN IF NOT EXISTS width integer NULL');
      await q('ALTER TABLE marketing.media_authorizations ADD COLUMN IF NOT EXISTS height integer NULL');
      await q('ALTER TABLE marketing.media_authorizations ADD COLUMN IF NOT EXISTS duration_s integer NULL');
      await q('ALTER TABLE marketing.media_authorizations DROP CONSTRAINT IF EXISTS mkt_media_auth_dims_chk');
      await q(`ALTER TABLE marketing.media_authorizations ADD CONSTRAINT mkt_media_auth_dims_chk CHECK (
        ((width IS NULL) = (height IS NULL)) AND (width IS NULL OR (width > 0 AND height > 0)) AND (duration_s IS NULL OR duration_s > 0))`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const [[{ n }]] = await sequelize.query('SELECT count(*)::int AS n FROM marketing.media_authorizations WHERE width IS NOT NULL OR duration_s IS NOT NULL', { transaction });
      if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} mídia(s) com medidas em marketing.media_authorizations.`);
      await sequelize.query('ALTER TABLE marketing.media_authorizations DROP CONSTRAINT IF EXISTS mkt_media_auth_dims_chk', { transaction });
      for (const column of ['duration_s', 'height', 'width']) await sequelize.query(`ALTER TABLE marketing.media_authorizations DROP COLUMN IF EXISTS ${column}`, { transaction });
    });
  },
};
