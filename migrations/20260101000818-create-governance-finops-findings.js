'use strict';

/**
 * M9-D862 — governance.finops_findings: o que os detectores de desperdício encontraram. Um achado por (empresa, detector, assunto) ENQUANTO ABERTO
 * (índice único parcial = idempotência: repetir o detector não duplica). `estimated_waste_cents` em centavos inteiros (fila é informativa: 0).
 * O achado resolve sozinho quando a condição some (`status` RESOLVED, `resolved_at`). Detectores só leem e informam: nenhuma outra tabela é alterada.
 * RLS + FORCE pela empresa (função do alicerce, GRANT guardado).
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.finops_findings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        detector varchar(20) NOT NULL,
        subject varchar(200) NOT NULL,
        evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
        estimated_waste_cents bigint NOT NULL DEFAULT 0,
        status varchar(8) NOT NULL DEFAULT 'OPEN',
        first_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_finops_findings_detector_chk CHECK (detector IN ('ORPHAN_STORAGE', 'LOG_VOLUME', 'QUEUE_BACKLOG', 'AI_MODEL_COST', 'EGRESS')),
        CONSTRAINT gov_finops_findings_status_chk CHECK (status IN ('OPEN', 'RESOLVED')),
        CONSTRAINT gov_finops_findings_waste_chk CHECK (estimated_waste_cents >= 0)
      )`);
      await q("CREATE UNIQUE INDEX IF NOT EXISTS gov_finops_findings_open_uq ON governance.finops_findings (company_id, detector, subject) WHERE status = 'OPEN'");
      await q('CREATE INDEX IF NOT EXISTS gov_finops_findings_status_idx ON governance.finops_findings (company_id, status, detector)');
      await q("SELECT governance.apply_tenant_rls('governance.finops_findings'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.finops_findings');
  },
};
