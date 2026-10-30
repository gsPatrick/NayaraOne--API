'use strict';

/**
 * M9-D426 — mídia do Marketing: autorização de uso e arquivos derivados.
 *  - marketing.media_authorizations: o arquivo do módulo de arquivos que a equipe autorizou para marketing (quem, quando, origem e SHA-256 do original). Uma linha por arquivo;
 *    revogar preenche revoked_at (a autorização some, o histórico fica).
 *  - marketing.media_derivatives: o arquivo NOVO gerado pela montagem (o original nunca é alterado). Guarda a lista de origens com o hash de cada uma (derived_from), o registro das
 *    operações (transform_log), a marca de conteúdo sintético e o hash das entradas (inputs_hash, único por empresa: a mesma montagem devolve o derivado existente). Só se insere.
 * RLS FORCE por grupo e empresa (fail-closed); GRANT ao nayara_runtime só se o role existir. Idempotente, numa transação. O down recusa se houver dado.
 */
const POLICY = `USING (group_id = NULLIF(current_setting('app.group_id', true), '')::uuid AND company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS marketing.media_authorizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        file_id uuid NOT NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        sha256 varchar(64) NOT NULL,
        origin varchar(40) NOT NULL,
        authorized_by uuid NOT NULL,
        authorized_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at timestamptz NULL,
        revoked_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mkt_media_auth_file_uq UNIQUE (company_id, file_id),
        CONSTRAINT mkt_media_auth_sha_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT mkt_media_auth_revoke_chk CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
      )`);
      await q(`CREATE TABLE IF NOT EXISTS marketing.media_derivatives (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        inputs_hash varchar(64) NOT NULL,
        derived_file_id uuid NOT NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        derived_sha256 varchar(64) NOT NULL,
        derived_from jsonb NOT NULL,
        transform_log jsonb NOT NULL,
        format varchar(16) NOT NULL,
        aspect_ratio varchar(12) NULL,
        duration_s integer NULL,
        synthetic boolean NOT NULL DEFAULT false,
        synthetic_kinds jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT mkt_media_deriv_inputs_uq UNIQUE (company_id, inputs_hash),
        CONSTRAINT mkt_media_deriv_sha_chk CHECK (derived_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT mkt_media_deriv_from_chk CHECK (jsonb_typeof(derived_from) = 'array' AND jsonb_array_length(derived_from) > 0),
        CONSTRAINT mkt_media_deriv_synth_chk CHECK (synthetic OR jsonb_array_length(synthetic_kinds) = 0)
      )`);
      await q('CREATE INDEX IF NOT EXISTS mkt_media_auth_group_idx ON marketing.media_authorizations (group_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_media_deriv_group_idx ON marketing.media_derivatives (group_id)');
      await q('CREATE INDEX IF NOT EXISTS mkt_media_deriv_file_idx ON marketing.media_derivatives (company_id, derived_file_id)');
      for (const table of ['media_authorizations', 'media_derivatives']) {
        await q(`ALTER TABLE marketing.${table} ENABLE ROW LEVEL SECURITY`);
        await q(`ALTER TABLE marketing.${table} FORCE ROW LEVEL SECURITY`);
        await q(`DROP POLICY IF EXISTS tenant_isolation ON marketing.${table}`);
        await q(`CREATE POLICY tenant_isolation ON marketing.${table} ${POLICY}`);
      }
      const [[{ exists }]] = await sequelize.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists", { transaction });
      if (exists) {
        await q('GRANT USAGE ON SCHEMA marketing TO nayara_runtime');
        await q('GRANT SELECT, INSERT, UPDATE ON marketing.media_authorizations TO nayara_runtime');
        await q('GRANT SELECT, INSERT ON marketing.media_derivatives TO nayara_runtime');
      }
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      for (const table of ['media_derivatives', 'media_authorizations']) {
        const [[{ reg }]] = await sequelize.query(`SELECT to_regclass('marketing.${table}') AS reg`, { transaction });
        if (reg) {
          const [[{ n }]] = await sequelize.query(`SELECT count(*)::int AS n FROM marketing.${table}`, { transaction });
          if (n > 0) throw new Error(`MKT_MIGRATION_DOWN_NOT_EMPTY: ${n} linha(s) em marketing.${table}; o histórico de mídia não é apagado.`);
        }
      }
      await sequelize.query('DROP TABLE IF EXISTS marketing.media_derivatives', { transaction });
      await sequelize.query('DROP TABLE IF EXISTS marketing.media_authorizations', { transaction });
    });
  },
};
