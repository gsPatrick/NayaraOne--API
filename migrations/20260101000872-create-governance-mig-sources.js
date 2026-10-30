'use strict';

/**
 * M9-D900 — governance.mig_sources: as fontes do sistema antigo (uma por sistema e entidade), semeadas por migration-v2/seeds (sem rota de cadastro). `mode` é CDC
 * (a fonte expõe log de mudanças), WATERMARK (coluna de controle) ou FULL_DIFF (exportação completa comparada por hash); `mode_reason` registra o motivo da escolha.
 * `config` não leva segredo (a credencial é só `secret_ref`, o NOME da variável de ambiente que a guarda). O checkpoint (`checkpoint_token`) só avança junto com o lote
 * confirmado. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.mig_sources (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        source_system varchar(40) NOT NULL,
        entity varchar(30) NOT NULL,
        mode varchar(12) NOT NULL,
        mode_reason text NOT NULL,
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        secret_ref varchar(120) NULL,
        enabled boolean NOT NULL DEFAULT true,
        checkpoint_token text NULL,
        checkpoint_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mig_sources_mode_chk CHECK (mode IN ('CDC', 'WATERMARK', 'FULL_DIFF')),
        CONSTRAINT mig_sources_reason_chk CHECK (length(btrim(mode_reason)) > 0),
        CONSTRAINT mig_sources_entity_chk CHECK (entity IN ('PERSON', 'PROPERTY', 'SUPPLIER', 'CONTRACT', 'FINANCIAL_ENTRY', 'LEAD', 'VISIT', 'PROPOSAL', 'PROJECT', 'PROJECT_STAGE', 'LEGAL_CASE', 'LEGAL_DEADLINE'))
      )`);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS mig_sources_uq ON governance.mig_sources (company_id, source_system, entity)');
      await q("SELECT governance.apply_tenant_rls('governance.mig_sources'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.mig_sources');
  },
};
