'use strict';

/**
 * M9-D911 — governance.retention_archives: a cópia arquivada (disposição ARCHIVE) do registro que chegou ao fim do prazo: conteúdo em JSON e o SHA-256 dele. Só
 * acrescenta: o gatilho recusa UPDATE e DELETE. Um registro é arquivado uma vez por alvo (a segunda tentativa não duplica). run_id guarda a rodada de origem sem chave estrangeira: o arquivo não pode ser alterado nem por ação referencial. RLS + FORCE (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.retention_archives (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        run_id uuid NULL,
        policy_code varchar(40) NOT NULL,
        target_code varchar(40) NOT NULL,
        record_id varchar(64) NOT NULL,
        content jsonb NOT NULL,
        content_hash varchar(64) NOT NULL,
        archived_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_ret_arch_uq UNIQUE (company_id, target_code, record_id)
      )`);
      await q(`CREATE OR REPLACE FUNCTION governance.refuse_retention_archive_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'O arquivo de retenção só recebe novas cópias; não pode ser alterado nem apagado.' USING ERRCODE = '23001'; END $fn$`);
      await q('DROP TRIGGER IF EXISTS gov_ret_arch_immutable ON governance.retention_archives');
      await q('CREATE TRIGGER gov_ret_arch_immutable BEFORE UPDATE OR DELETE ON governance.retention_archives FOR EACH ROW EXECUTE FUNCTION governance.refuse_retention_archive_change()');
      await q("SELECT governance.apply_tenant_rls('governance.retention_archives'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.retention_archives');
    await queryInterface.sequelize.query('DROP FUNCTION IF EXISTS governance.refuse_retention_archive_change()');
  },
};
