'use strict';

/**
 * M9-D822 — POST /exports: o mesmo governance.export_jobs (M9-D821) passa a guardar o pedido de arquivo e o que a geração produz: formato, filtro, colunas, marca d'água,
 * o arquivo (people.files) com o hash (que fica quando o arquivo é apagado na expiração), a contagem de linhas, o instante da geração/expiração e o código de falha.
 * A tabela já tem RLS + FORCE (migration 821); aqui só colunas e um índice para o job de expiração. Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`ALTER TABLE governance.export_jobs
        ADD COLUMN IF NOT EXISTS format varchar(4) NULL,
        ADD COLUMN IF NOT EXISTS export_filter jsonb NULL,
        ADD COLUMN IF NOT EXISTS export_columns jsonb NULL,
        ADD COLUMN IF NOT EXISTS watermark boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS file_name varchar(255) NULL,
        ADD COLUMN IF NOT EXISTS file_sha256 varchar(64) NULL,
        ADD COLUMN IF NOT EXISTS row_count integer NULL,
        ADD COLUMN IF NOT EXISTS generated_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS expired_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS error_code varchar(60) NULL,
        ADD COLUMN IF NOT EXISTS download_count integer NOT NULL DEFAULT 0`);
      await q('ALTER TABLE governance.export_jobs DROP CONSTRAINT IF EXISTS gov_expjob_format_chk');
      await q("ALTER TABLE governance.export_jobs ADD CONSTRAINT gov_expjob_format_chk CHECK (format IS NULL OR format IN ('CSV', 'XLSX', 'PDF'))");
      await q("CREATE INDEX IF NOT EXISTS gov_expjob_work_idx ON governance.export_jobs (company_id, status, expires_at) WHERE status IN ('APPROVED', 'GENERATING', 'READY')");
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP INDEX IF EXISTS governance.gov_expjob_work_idx');
      await q('ALTER TABLE governance.export_jobs DROP CONSTRAINT IF EXISTS gov_expjob_format_chk');
      await q(`ALTER TABLE governance.export_jobs
        DROP COLUMN IF EXISTS format, DROP COLUMN IF EXISTS export_filter, DROP COLUMN IF EXISTS export_columns, DROP COLUMN IF EXISTS watermark,
        DROP COLUMN IF EXISTS file_id, DROP COLUMN IF EXISTS file_name, DROP COLUMN IF EXISTS file_sha256, DROP COLUMN IF EXISTS row_count,
        DROP COLUMN IF EXISTS generated_at, DROP COLUMN IF EXISTS expired_at, DROP COLUMN IF EXISTS error_code, DROP COLUMN IF EXISTS download_count`);
    });
  },
};
