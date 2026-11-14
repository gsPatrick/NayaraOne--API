'use strict';

const { validarSeLimpo } = require('../src/shared/db/validarSeLimpo');
/**
 * Caderno M5 §15 + Guia do Marcelo §12 (createDeadline: `if (!input.sourceFileId && !input.sourceEventId) throw
 * DEADLINE_SOURCE_REQUIRED`; `tasks.create({ responsibleUserId, dueAt, severity, sourceType: 'LEGAL_DEADLINE', sourceId })`):
 *  - source_file_id: arquivo íntegro da empresa que originou o prazo (intimação, publicação, decisão);
 *  - source_event_id + source_event_type: evento real da empresa que originou o prazo (integration.outbox_events ou
 *    audit.audit_log); polimórfico, sem FK, conferido pela aplicação;
 *  - task_id: tarefa do responsável criada na mesma transação do prazo (core.tasks);
 *  - cancelled_at / cancelled_by / cancel_reason: cancelamento com motivo (PENDING -> CANCELLED, terminal).
 * Os campos de texto source_document/source_event continuam (dado legado e descrição complementar). Reversível.
 */
const TABLE = 'legal.legal_deadlines';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q(`ALTER TABLE ${TABLE}
        ADD COLUMN IF NOT EXISTS source_file_id uuid NULL REFERENCES people.files(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS source_event_id uuid NULL,
        ADD COLUMN IF NOT EXISTS source_event_type varchar(32) NULL,
        ADD COLUMN IF NOT EXISTS task_id uuid NULL REFERENCES core.tasks(id) ON UPDATE CASCADE ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS cancelled_at timestamptz NULL,
        ADD COLUMN IF NOT EXISTS cancelled_by uuid NULL,
        ADD COLUMN IF NOT EXISTS cancel_reason text NULL`);
      await q(`DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_deadlines_source_event_type_chk') THEN
          ALTER TABLE ${TABLE} ADD CONSTRAINT legal_deadlines_source_event_type_chk
            CHECK ((source_event_id IS NULL AND source_event_type IS NULL) OR (source_event_id IS NOT NULL AND source_event_type IN ('OUTBOX_EVENT', 'AUDIT_LOG')));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'legal_deadlines_status_chk') THEN
          ALTER TABLE ${TABLE} ADD CONSTRAINT legal_deadlines_status_chk CHECK (status IN ('PENDING', 'DONE', 'CANCELLED')) NOT VALID;
        END IF;
      END $c$`);
      await q(`CREATE INDEX IF NOT EXISTS legal_deadlines_task_id_idx ON ${TABLE} (task_id)`);
      await q(`CREATE INDEX IF NOT EXISTS legal_deadlines_source_file_id_idx ON ${TABLE} (source_file_id)`);
      // NOT VALID só enquanto houver linha antiga fora da regra (src/shared/db/validarSeLimpo.js).
      await validarSeLimpo(q, 'legal.legal_deadlines', 'legal_deadlines_status_chk', '20260101009997');
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE ${TABLE}
      DROP CONSTRAINT IF EXISTS legal_deadlines_status_chk,
      DROP CONSTRAINT IF EXISTS legal_deadlines_source_event_type_chk,
      DROP COLUMN IF EXISTS cancel_reason, DROP COLUMN IF EXISTS cancelled_by, DROP COLUMN IF EXISTS cancelled_at,
      DROP COLUMN IF EXISTS task_id, DROP COLUMN IF EXISTS source_event_type, DROP COLUMN IF EXISTS source_event_id,
      DROP COLUMN IF EXISTS source_file_id`);
  },
};
