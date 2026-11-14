'use strict';

const { forceRestaurado } = require('../../../../../shared/db/forceRestaurado');
const { randomUUID } = require('crypto');

/**
 * M4PG — verificação independente do Marco 4 (partes 1 e 2): pagamento, aprovação, estorno e reabertura.
 *
 * 1. finance.payment_intents com os estados do Guia §3 (DEC-056): DRAFT | PENDING_APPROVAL | APPROVED | EXECUTING | CONFIRMED | FAILED |
 *    CANCELED, e a fase do envio ao banco em submission_phase (NOT_STARTED | SUBMITTING | SUBMITTED | UNCERTAIN). Migração de DADOS:
 *    PENDING→PENDING_APPROVAL, SUBMITTING→EXECUTING/SUBMITTING (UNCERTAIN quando a resposta do banco ficou incerta), SUBMITTED→EXECUTING/
 *    SUBMITTED, EXECUTED→CONFIRMED, CANCELLED→CANCELED. Cada linha convertida deixa um registro no audit_log com antes/depois; nada é
 *    apagado. Colunas novas: amount (Guia §3; valor/parcela escolhido no PREPARE, Caderno §8.2) e installment_number. CHECK dos estados
 *    e o índice único "uma intenção em aberto por lançamento" com os estados novos.
 * 2. finance.approval_requests guarda o retrato aprovável e o hash dele, o nº de aprovadores e a versão da regra REG-FIN-002 (ou a origem
 *    PARAMETERS), o motivo, o valor e os dados do pedido (Caderno §5 "Snapshot de aprovação"; Guia §4 createFromRule).
 * 3. Permissões próprias: finance:reverse (pedir estorno, DEC-062) e finance:periodReopen (reabertura CRITICAL, Caderno §16), semeadas e
 *    concedidas ao papel ADMIN (PADRAO_COMPONENTES_E_REGRAS §2.5). O down devolve tudo, com auditoria da volta dos estados.
 */
const MAP_UP = [
  ['PENDING', 'PENDING_APPROVAL', "'NOT_STARTED'"],
  ['SUBMITTING', 'EXECUTING', "CASE WHEN external_status = 'UNCERTAIN' THEN 'UNCERTAIN' ELSE 'SUBMITTING' END"],
  ['SUBMITTED', 'EXECUTING', "'SUBMITTED'"],
  ['EXECUTED', 'CONFIRMED', 'submission_phase'],
  ['CANCELLED', 'CANCELED', 'submission_phase'],
];
const NEW_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING', 'CONFIRMED', 'FAILED', 'CANCELED'];
const PERMISSIONS = [
  ['finance:reverse', 'Pedir estorno de movimento financeiro (o estorno só é lançado depois que outra pessoa aprova o caso).', 'HIGH'],
  ['finance:periodReopen', 'Pedir e aprovar a reabertura de período financeiro fechado (fluxo CRITICAL, duas pessoas com MFA).', 'CRITICAL'],
];
const APPROVAL_COLUMNS = [
  ['snapshot_json', 'jsonb'], ['snapshot_hash', 'varchar(64)'], ['required_approvals', 'integer'], ['rule_version_id', 'uuid'],
  ['risk_source', 'varchar(16)'], ['reason', 'text'], ['amount', 'numeric(18,2)'], ['payload_json', 'jsonb'],
];

async function withRlsOpen(q, tables, fn) {
  const [rows] = await q(`SELECT n.nspname || '.' || c.relname AS t, c.relforcerowsecurity AS f FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE (n.nspname || '.' || c.relname) IN (:tables)`, { tables });
  const forced = rows.filter((r) => r.f).map((r) => r.t);
  for (const t of forced) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
  return await forceRestaurado(async () => { return await fn(); }, async () => { for (const t of forced) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); });
}

async function convertStatuses(q, pairs, reason, action) {
  for (const [from, to, phaseSql] of pairs) {
    const [rows] = await q(
      `UPDATE finance.payment_intents p SET status = :to, submission_phase = ${phaseSql}
         FROM (SELECT id, status AS antes, submission_phase AS fase_antes FROM finance.payment_intents WHERE status = :from FOR UPDATE) v
        WHERE p.id = v.id
        RETURNING p.id, p.group_id, p.company_id, v.antes, v.fase_antes, p.status, p.submission_phase`,
      { from, to }
    );
    for (const r of rows) {
      await q(
        `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, NULL, :action, 'PaymentIntent', :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`,
        {
          g: r.group_id, c: r.company_id, id: r.id, action,
          b: JSON.stringify({ status: r.antes, submissionPhase: r.fase_antes }),
          a: JSON.stringify({ status: r.status, submissionPhase: r.submission_phase }),
          r: reason,
        }
      );
    }
  }
}

module.exports = {
  MAP_UP,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q(`ALTER TABLE finance.payment_intents
                 ADD COLUMN IF NOT EXISTS submission_phase varchar(16) NOT NULL DEFAULT 'NOT_STARTED',
                 ADD COLUMN IF NOT EXISTS amount numeric(18,2) NULL,
                 ADD COLUMN IF NOT EXISTS installment_number integer NULL`);
      await q("ALTER TABLE finance.payment_intents ALTER COLUMN status SET DEFAULT 'DRAFT'");
      await q('DROP INDEX IF EXISTS finance.payment_intents_one_open_per_entry');
      await withRlsOpen(q, ['finance.payment_intents', 'audit.audit_log'], async () => {
        await convertStatuses(q, MAP_UP,
          'Migration 20260101011400 (DEC-056, Guia M4 §3): estado da intenção de pagamento convertido para os estados do livro; a fase do envio ao banco foi para submission_phase.',
          'finance.payment_intent.status_migrated');
        // Guia §3 amount: as intenções antigas pagam o valor cheio do retrato.
        await q(`UPDATE finance.payment_intents SET amount = (snapshot_json->>'amount')::numeric(18,2)
                  WHERE amount IS NULL AND snapshot_json->>'amount' ~ '^[0-9]+(\\.[0-9]{1,2})?$'`);
      });
      await q(`ALTER TABLE finance.payment_intents ADD CONSTRAINT payment_intents_status_chk CHECK (status IN (${NEW_STATUSES.map((s) => `'${s}'`).join(', ')}))`);
      await q(`ALTER TABLE finance.payment_intents ADD CONSTRAINT payment_intents_submission_phase_chk
                 CHECK (submission_phase IN ('NOT_STARTED', 'SUBMITTING', 'SUBMITTED', 'UNCERTAIN'))`);
      await q(`CREATE UNIQUE INDEX payment_intents_one_open_per_entry ON finance.payment_intents (financial_entry_id)
                WHERE status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'EXECUTING')`);

      await q(`ALTER TABLE finance.approval_requests ${APPROVAL_COLUMNS.map(([c, t]) => `ADD COLUMN IF NOT EXISTS ${c} ${t} NULL`).join(', ')}`);
      await q(`ALTER TABLE finance.approval_requests ADD CONSTRAINT approval_requests_required_approvals_chk CHECK (required_approvals IS NULL OR required_approvals BETWEEN 1 AND 5)`);

      const now = new Date();
      await queryInterface.bulkInsert(
        { tableName: 'permissions', schema: 'core' },
        PERMISSIONS.map(([code, description, risk]) => ({ id: randomUUID(), code, description, risk_level: risk, created_at: now, updated_at: now })),
        { ignoreDuplicates: true, transaction }
      );
      await withRlsOpen(q, ['core.companies', 'core.roles'], () => q(`
        INSERT INTO core.role_permissions (id, role_id, permission_id, created_at, updated_at)
        SELECT gen_random_uuid(), r.id, p.id, now(), now()
          FROM core.roles r CROSS JOIN core.permissions p
         WHERE r.name = 'ADMIN' AND p.code IN (:codes)
           AND NOT EXISTS (SELECT 1 FROM core.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id)`,
      { codes: PERMISSIONS.map(([c]) => c) }));
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('ALTER TABLE finance.payment_intents DROP CONSTRAINT IF EXISTS payment_intents_status_chk');
      await q('ALTER TABLE finance.payment_intents DROP CONSTRAINT IF EXISTS payment_intents_submission_phase_chk');
      await q('DROP INDEX IF EXISTS finance.payment_intents_one_open_per_entry');
      const down = [
        ['DRAFT', 'PENDING', 'submission_phase'],
        ['PENDING_APPROVAL', 'PENDING', 'submission_phase'],
        ['CONFIRMED', 'EXECUTED', 'submission_phase'],
        ['CANCELED', 'CANCELLED', 'submission_phase'],
      ];
      await withRlsOpen(q, ['finance.payment_intents', 'audit.audit_log'], async () => {
        await convertStatuses(q, down, 'Migration 20260101011400 desfeita: estado da intenção volta ao nome anterior à DEC-056.', 'finance.payment_intent.status_migrated_back');
        for (const [phase, legacy] of [['SUBMITTED', 'SUBMITTED'], ['SUBMITTING', 'SUBMITTING'], ['UNCERTAIN', 'SUBMITTING'], ['NOT_STARTED', 'SUBMITTING']]) {
          await sequelize.query(
            `WITH v AS (SELECT id FROM finance.payment_intents WHERE status = 'EXECUTING' AND submission_phase = :phase FOR UPDATE)
             INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
             SELECT gen_random_uuid(), p.group_id, p.company_id, NULL, 'finance.payment_intent.status_migrated_back', 'PaymentIntent', p.id,
                    jsonb_build_object('status', p.status, 'submissionPhase', p.submission_phase), jsonb_build_object('status', :legacy),
                    'Migration 20260101011400 desfeita: EXECUTING volta ao estado anterior à DEC-056.', now(), now(), now()
               FROM finance.payment_intents p JOIN v ON v.id = p.id`,
            { transaction, replacements: { phase, legacy } }
          );
          await q("UPDATE finance.payment_intents SET status = :legacy WHERE status = 'EXECUTING' AND submission_phase = :phase", { phase, legacy });
        }
      });
      await q(`CREATE UNIQUE INDEX payment_intents_one_open_per_entry ON finance.payment_intents (financial_entry_id)
                WHERE status IN ('PENDING', 'APPROVED', 'SUBMITTING', 'SUBMITTED')`);
      await q("ALTER TABLE finance.payment_intents ALTER COLUMN status SET DEFAULT 'PENDING'");
      await q('ALTER TABLE finance.payment_intents DROP COLUMN IF EXISTS submission_phase, DROP COLUMN IF EXISTS amount, DROP COLUMN IF EXISTS installment_number');
      await q('ALTER TABLE finance.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_required_approvals_chk');
      await q(`ALTER TABLE finance.approval_requests ${APPROVAL_COLUMNS.map(([c]) => `DROP COLUMN IF EXISTS ${c}`).join(', ')}`);
      await q('DELETE FROM core.role_permissions WHERE permission_id IN (SELECT id FROM core.permissions WHERE code IN (:codes))', { codes: PERMISSIONS.map(([c]) => c) });
      await q('DELETE FROM core.permissions WHERE code IN (:codes)', { codes: PERMISSIONS.map(([c]) => c) });
    });
  },
};
