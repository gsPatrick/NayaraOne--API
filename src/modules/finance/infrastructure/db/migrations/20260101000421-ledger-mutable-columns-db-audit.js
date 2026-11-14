'use strict';

/**
 * Frente 3 (Regras do Financeiro, Marco 4) — revisão independente 18/10/2026, item 12:
 * "Ledger: testes ... da auditoria das colunas mutáveis".
 *
 * O trigger append-only (366/382) bloqueia as colunas do FATO; as colunas que o fluxo normal
 * precisa mudar (status, settled_at, conta bancária, dimensões gerenciais, nature saindo de
 * PENDING_CLASSIFICATION, classificação contábil, comprovante...) só eram auditadas quando a
 * mudança passava pelo serviço. Um UPDATE direto (SQL cru com o usuário de runtime) mudava, por
 * exemplo, a conta bancária de um lançamento PENDING sem deixar rastro.
 *
 * Este trigger AFTER UPDATE grava em audit.audit_log (append-only, migration 490) TODA mudança
 * de coluna de finance.financial_entries — só as colunas que mudaram, antes e depois —, com o
 * usuário de `app.user_id`. Colunas de controle (updated_at, updated_by, lock_version) não
 * contam como mudança. entity_type = 'FinancialEntryRow' para não se misturar com a auditoria
 * de negócio do serviço (entity_type 'FinancialEntry').
 */

const FUNCTION_NAME = 'finance.audit_financial_entries_row_change';
const TRIGGER_NAME = 'trg_financial_entries_row_change_audit';

module.exports = {
  async up(queryInterface) {
    const q = (sql) => queryInterface.sequelize.query(sql);
    await q(`
      CREATE OR REPLACE FUNCTION ${FUNCTION_NAME}()
      RETURNS TRIGGER AS $$
      DECLARE
        old_j jsonb := to_jsonb(OLD) - 'updated_at' - 'updated_by' - 'lock_version';
        new_j jsonb := to_jsonb(NEW) - 'updated_at' - 'updated_by' - 'lock_version';
        before_j jsonb := '{}'::jsonb;
        after_j jsonb := '{}'::jsonb;
        k text;
      BEGIN
        IF old_j = new_j THEN
          RETURN NULL;
        END IF;
        FOR k IN SELECT jsonb_object_keys(new_j) LOOP
          IF (old_j -> k) IS DISTINCT FROM (new_j -> k) THEN
            before_j := before_j || jsonb_build_object(k, old_j -> k);
            after_j := after_j || jsonb_build_object(k, new_j -> k);
          END IF;
        END LOOP;
        INSERT INTO audit.audit_log
          (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
        VALUES
          (gen_random_uuid(), NEW.group_id, NEW.company_id, NULLIF(current_setting('app.user_id', true), '')::uuid,
           'finance.financial_entry.row_change', 'FinancialEntryRow', NEW.id, before_j, after_j,
           'Mudança de coluna mutável do ledger registrada pelo banco (trigger) — colunas: ' ||
             (SELECT string_agg(x, ', ' ORDER BY x) FROM jsonb_object_keys(after_j) AS x),
           now(), now(), now());
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await q(`
      DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "finance"."financial_entries";
      CREATE TRIGGER ${TRIGGER_NAME}
        AFTER UPDATE ON "finance"."financial_entries"
        FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}();
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON "finance"."financial_entries";`);
    await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS ${FUNCTION_NAME}();`);
  },
};
