'use strict';

/**
 * M9-D805 — governance.review_queue_items: a fila de merge e review de Person, Property e Supplier (fornecedor é pessoa com o papel
 * SUPPLIER). `kind` MERGE_CANDIDATE guarda um par (primary_id, secondary_id); REVIEW guarda um cadastro só (secondary_id nulo).
 * Índices únicos: o par não repete na fila aberta nem volta depois de decidido como separado ou descartado (MERGED sai do índice porque
 * o secundário passa a merged_into); um REVIEW aberto por cadastro. RLS + FORCE pela função do alicerce (M9-D800). Reversível.
 */
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`CREATE TABLE IF NOT EXISTS governance.review_queue_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        entity_type varchar(20) NOT NULL,
        kind varchar(20) NOT NULL,
        primary_id uuid NOT NULL,
        secondary_id uuid NULL,
        reason_code varchar(40) NOT NULL,
        score numeric(5,2) NOT NULL,
        status varchar(20) NOT NULL DEFAULT 'OPEN',
        assigned_steward_id uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        decided_by uuid NULL REFERENCES core.users(id) ON UPDATE CASCADE ON DELETE SET NULL,
        decided_at timestamptz NULL,
        decision_note text NULL,
        survivor_id uuid NULL,
        evidence jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT gov_queue_entity_chk CHECK (entity_type IN ('PERSON', 'PROPERTY', 'SUPPLIER')),
        CONSTRAINT gov_queue_kind_chk CHECK (kind IN ('MERGE_CANDIDATE', 'REVIEW')),
        CONSTRAINT gov_queue_status_chk CHECK (status IN ('OPEN', 'IN_REVIEW', 'MERGED', 'KEPT_SEPARATE', 'DISMISSED')),
        CONSTRAINT gov_queue_score_chk CHECK (score >= 0 AND score <= 100),
        CONSTRAINT gov_queue_pair_chk CHECK ((kind = 'MERGE_CANDIDATE' AND secondary_id IS NOT NULL AND secondary_id <> primary_id) OR (kind = 'REVIEW' AND secondary_id IS NULL)),
        CONSTRAINT gov_queue_final_chk CHECK (status NOT IN ('MERGED', 'KEPT_SEPARATE', 'DISMISSED') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
        CONSTRAINT gov_queue_survivor_chk CHECK (survivor_id IS NULL OR survivor_id IN (primary_id, secondary_id))
      )`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS gov_queue_pair_uq ON governance.review_queue_items
        (company_id, entity_type, LEAST(primary_id, secondary_id), GREATEST(primary_id, secondary_id))
        WHERE kind = 'MERGE_CANDIDATE' AND status IN ('OPEN', 'IN_REVIEW', 'KEPT_SEPARATE', 'DISMISSED')`);
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS gov_queue_review_uq ON governance.review_queue_items (company_id, entity_type, primary_id)
        WHERE kind = 'REVIEW' AND status IN ('OPEN', 'IN_REVIEW')`);
      await q('CREATE INDEX IF NOT EXISTS gov_queue_list_idx ON governance.review_queue_items (company_id, status, entity_type, score DESC, created_at)');
      await q("SELECT governance.apply_tenant_rls('governance.review_queue_items'::regclass)");
    });
  },
  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS governance.review_queue_items');
  },
};
