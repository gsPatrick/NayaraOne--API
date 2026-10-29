'use strict';

/**
 * M9-D830 — governance.bcp_sectors: o catálogo FECHADO dos seis setores da continuidade operacional (Caderno §5): ATENDIMENTO (ATD), LOCACAO (LOC), FINANCEIRO (FIN),
 * OBRAS (OBR), CORRESPONDENTE (COR) e JURIDICO (JUR), com o prefixo do formulário contingencial e o arquivo do runbook. É catálogo do sistema, igual para toda empresa
 * (sem company_id): RLS + FORCE com uma política só de leitura; o role de runtime recebe apenas SELECT (GRANT dentro de guarda de existência). Semeada com exatamente
 * seis linhas, idempotente. Reversível.
 */
const SECTORS = [
  ['ATENDIMENTO', 'ATD', 'atendimento.md', 'Atendimento', 1],
  ['LOCACAO', 'LOC', 'locacao.md', 'Locação', 2],
  ['FINANCEIRO', 'FIN', 'financeiro.md', 'Financeiro', 3],
  ['OBRAS', 'OBR', 'obras.md', 'Obras', 4],
  ['CORRESPONDENTE', 'COR', 'correspondente.md', 'Correspondente bancário', 5],
  ['JURIDICO', 'JUR', 'juridico.md', 'Jurídico', 6],
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q(`CREATE TABLE IF NOT EXISTS governance.bcp_sectors (
        sector varchar(20) PRIMARY KEY,
        form_prefix char(3) NOT NULL,
        runbook_file varchar(60) NOT NULL,
        label varchar(60) NOT NULL,
        position smallint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_bcp_sectors_prefix_uq UNIQUE (form_prefix),
        CONSTRAINT gov_bcp_sectors_position_uq UNIQUE (position)
      )`);
      for (const row of SECTORS) {
        await q('INSERT INTO governance.bcp_sectors (sector, form_prefix, runbook_file, label, position) VALUES (?, ?, ?, ?, ?) ON CONFLICT (sector) DO NOTHING', row);
      }
      await q('ALTER TABLE governance.bcp_sectors ENABLE ROW LEVEL SECURITY');
      await q('ALTER TABLE governance.bcp_sectors FORCE ROW LEVEL SECURITY');
      await q(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'governance.bcp_sectors'::regclass AND polname = 'bcp_sectors_read') THEN
          CREATE POLICY bcp_sectors_read ON governance.bcp_sectors FOR SELECT USING (true);
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN
          GRANT SELECT ON governance.bcp_sectors TO nayara_runtime;
        END IF;
      END $$`);
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.bcp_sectors');
  },
};
