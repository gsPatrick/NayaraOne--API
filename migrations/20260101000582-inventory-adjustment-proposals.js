'use strict';

/**
 * Revisão Marco 7 (19/10/2026), item A6 — EST-008 ("Ajuste de estoque exige motivo, evidência e
 * aprovação conforme valor/risco"; Caderno: "Ajuste aprovado cria movement ADJUSTMENT com
 * evidência e motivo"). Quem tinha inventory:approve registrava e "aprovava" o próprio
 * ADJUSTMENT/DISPOSAL manual. Agora o ajuste manual nasce como PROPOSTA (PENDING), sem mexer no
 * saldo; outra pessoa com inventory:approve aprova (gera o movimento, sourceType
 * ADJUSTMENT_PROPOSAL) ou rejeita. A segregação também é garantida no banco (CHECK
 * decided_by_user_id <> proposed_by_user_id).
 */
module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`CREATE TABLE IF NOT EXISTS inventory.adjustment_proposals (
               id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
               group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
               company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
               inventory_item_id uuid NOT NULL REFERENCES inventory.inventory_items(id) ON UPDATE CASCADE ON DELETE RESTRICT,
               movement_type varchar(16) NOT NULL CHECK (movement_type IN ('ADJUSTMENT','DISPOSAL')),
               quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
               source_location_id uuid NULL REFERENCES inventory.locations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
               destination_location_id uuid NULL REFERENCES inventory.locations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
               project_id uuid NULL REFERENCES construction.projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
               stage_id uuid NULL,
               reason varchar(500) NOT NULL CHECK (length(btrim(reason)) > 0),
               evidence_file_id uuid NULL,
               estimated_value numeric(18,2) NULL,
               idempotency_key varchar(255) NOT NULL,
               status varchar(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
               proposed_by_user_id uuid NOT NULL REFERENCES core.users(id),
               decided_by_user_id uuid NULL REFERENCES core.users(id),
               decided_at timestamptz NULL,
               decision_note varchar(500) NULL,
               resulting_movement_id uuid NULL REFERENCES inventory.inventory_movements(id) ON UPDATE CASCADE ON DELETE SET NULL,
               created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
               updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
               CONSTRAINT adjustment_proposals_segregation_chk CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> proposed_by_user_id),
               CONSTRAINT adjustment_proposals_company_idempotency_unique UNIQUE (company_id, idempotency_key)
             )`);
    await q(`CREATE INDEX IF NOT EXISTS adjustment_proposals_company_status_idx
               ON inventory.adjustment_proposals (company_id, status, created_at DESC)`);
    await q('ALTER TABLE inventory.adjustment_proposals ENABLE ROW LEVEL SECURITY');
    await q('ALTER TABLE inventory.adjustment_proposals FORCE ROW LEVEL SECURITY');
    await q('DROP POLICY IF EXISTS tenant_isolation ON inventory.adjustment_proposals');
    await q(`CREATE POLICY tenant_isolation ON inventory.adjustment_proposals
               USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
    const [[{ exists }]] = await q("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists");
    if (exists) {
      // Sem DELETE: proposta decidida é registro de auditoria.
      await q('GRANT SELECT, INSERT, UPDATE ON inventory.adjustment_proposals TO nayara_runtime');
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS inventory.adjustment_proposals');
  },
};
