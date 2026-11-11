'use strict';

/**
 * Ida e volta da migration 20260101010520 (DDL mínimo do ledger, Caderno M4 §7). Tudo numa transação: as correções de
 * dado vêm antes das constraints, cada uma registrada em finance.ledger_m4lr_migration_log (linha, coluna, antes e
 * depois) e, pelas mudanças de coluna, no audit.audit_log (gatilho da migration 421); a contagem por empresa antes e
 * depois vai para o log e para o audit.audit_log (ação finance.ledger.m4lr_migration). O down desfaz pelo log.
 */
const S = require('./ledger-ddl-m4lr.sql');

const FE = 'finance.financial_entries';
const LOG = 'finance.ledger_m4lr_migration_log';
const RLS_TABLES = [FE, 'audit.audit_log', 'finance.payment_intents', 'finance.bank_transactions'];
const CHILD = S.SETTLEMENT_CHILD_SQL('c');
const MOVEMENT_KINDS_SQL = "('PARTIAL', 'COMPLEMENT', 'EXCESS', 'REVERSAL')";
const REASON_ZERO = 'Legado M4LR: valor 0,00 gravado antes do filtro de centavos (FIN-008; ex.: "1e-3" arredondado pelo banco). Não há dinheiro: fica fora do ledger.';
const REASON_NOT_REALIZED = 'Legado M4LR: estorno lançado sobre lançamento previsto que nunca foi realizado (Caderno §6: OPEN não tem ledger). Não é movimento: fica fora do ledger.';
const REASON_PARENT = 'Legado M4LR: estorno do valor cheio de um lançamento com baixas parciais; o estorno é por baixa (Caderno §6). Substituído pelo estorno de cada baixa (ver ledger_m4lr_migration_log).';

const COUNTS_SQL = (ledgerSum) => `
  SELECT company_id,
         count(*)::int AS total,
         count(*) FILTER (WHERE idempotency_key IS NULL)::int AS sem_chave,
         count(*) FILTER (WHERE created_by IS NULL)::int AS sem_autor,
         count(*) FILTER (WHERE amount <= 0)::int AS valor_nao_positivo,
         count(*) FILTER (WHERE settlement_method IN ('BANK_CONFIRMED', 'SANDBOX_CONFIRMED') AND bank_account_id IS NULL)::int AS confirmado_pelo_banco_sem_conta,
         (SELECT count(*) FROM finance.ledger l WHERE l.company_id = x.company_id)::int AS linhas_do_ledger,
         (SELECT COALESCE(SUM(${ledgerSum}), 0)::text FROM finance.ledger l WHERE l.company_id = x.company_id) AS saldo_do_ledger
    FROM ${FE} x GROUP BY company_id`;

async function runtimeExists(q) {
  const [[{ exists }]] = await q("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists");
  return exists;
}

async function counts(q, ledgerSum) {
  const [rows] = await q(COUNTS_SQL(ledgerSum));
  return rows;
}

async function logCounts(q, step, rows) {
  for (const r of rows) {
    await q(`INSERT INTO ${LOG} (step, company_id, detail) VALUES (:step, :c, CAST(:d AS jsonb))`, { step, c: r.company_id, d: JSON.stringify(r) });
  }
}

async function auditSummary(q, before, after) {
  const byCompany = new Map(before.map((r) => [r.company_id, { before: r }]));
  for (const r of after) byCompany.set(r.company_id, { ...(byCompany.get(r.company_id) || {}), after: r });
  for (const [companyId, v] of byCompany) {
    const [[step]] = await q(`SELECT count(*) FILTER (WHERE step NOT LIKE 'CONTAGEM%')::int AS n FROM ${LOG} WHERE company_id = :c`, { c: companyId });
    await q(
      `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
       SELECT gen_random_uuid(), c.group_id, c.id, NULL, 'finance.ledger.m4lr_migration', 'LedgerMigration', c.id, CAST(:b AS jsonb), CAST(:a AS jsonb), :r, now(), now(), now()
         FROM core.companies c WHERE c.id = :c`,
      { c: companyId, b: JSON.stringify(v.before || {}), a: JSON.stringify(v.after || {}),
        r: `Migration 20260101010520 (M4LR, Caderno M4 §7): ${step.n} correção(ões) de dado antes das constraints do ledger; detalhe em finance.ledger_m4lr_migration_log.` }
    );
  }
}

/** UPDATE ... RETURNING registrado no log, linha a linha. `sql` devolve id, company_id, old_value, new_value. */
async function fix(q, step, column, sql) {
  const [rows] = await q(sql);
  for (const r of rows) {
    await q(`INSERT INTO ${LOG} (step, company_id, entry_id, column_name, old_value, new_value, detail) VALUES (:s, :c, :e, :col, :o, :n, CAST(:d AS jsonb))`,
      { s: step, c: r.company_id, e: r.id, col: column, o: r.old_value === undefined ? null : r.old_value, n: r.new_value === undefined ? null : r.new_value, d: JSON.stringify(r.detail || {}) });
  }
  return rows.length;
}

async function fixData(q) {
  await fix(q, 'TIPO_DO_MOVIMENTO', 'movement_kind', `
    UPDATE ${FE} e SET movement_kind = CASE
        WHEN e.reversal_of_entry_id IS NOT NULL THEN 'REVERSAL'
        WHEN e.nature = 'PENDING_CLASSIFICATION' OR e.idempotency_key LIKE '%:excedente' OR e.description LIKE 'Valor recebido a mais (%' THEN 'EXCESS'
        ELSE 'PARTIAL' END
     WHERE e.movement_kind IS NULL AND (e.parent_entry_id IS NOT NULL OR e.reversal_of_entry_id IS NOT NULL)
    RETURNING e.id, e.company_id, NULL AS old_value, e.movement_kind AS new_value`);
  await fix(q, 'CHAVE_LEGADO', 'idempotency_key', `
    UPDATE ${FE} e SET idempotency_key = 'legado:' || e.id::text WHERE e.idempotency_key IS NULL
    RETURNING e.id, e.company_id, NULL AS old_value, e.idempotency_key AS new_value`);
  await fix(q, 'AUTOR', 'created_by', `
    WITH movement_actor AS (
      SELECT DISTINCT ON (v.k) v.k AS entry_id, a.user_id
        FROM audit.audit_log a
        CROSS JOIN LATERAL (VALUES (a.after_json->>'settlementEntryId'), (a.after_json->>'reversalEntryId'), (a.after_json->>'classificationPendingEntryId')) v(k)
       WHERE a.entity_type = 'FinancialEntry' AND a.user_id IS NOT NULL AND v.k IS NOT NULL
       ORDER BY v.k, a.occurred_at),
    src AS (
      SELECT e.id,
             (SELECT a.user_id FROM audit.audit_log a WHERE a.entity_type = 'FinancialEntry' AND a.entity_id = e.id AND a.user_id IS NOT NULL ORDER BY a.occurred_at LIMIT 1) AS own_actor,
             (SELECT m.user_id FROM movement_actor m WHERE m.entry_id = e.id::text) AS movement_actor,
             e.updated_by
        FROM ${FE} e WHERE e.created_by IS NULL)
    UPDATE ${FE} e SET created_by = COALESCE(src.own_actor, src.movement_actor, src.updated_by, '${S.SYSTEM_ACTOR_ID}'::uuid)
      FROM src WHERE src.id = e.id
    RETURNING e.id, e.company_id, NULL AS old_value, e.created_by::text AS new_value,
              jsonb_build_object('origem', CASE WHEN src.own_actor IS NOT NULL THEN 'auditoria do lançamento' WHEN src.movement_actor IS NOT NULL THEN 'auditoria da baixa/estorno'
                                                WHEN src.updated_by IS NOT NULL THEN 'updated_by' ELSE 'ator de sistema (sem autor registrado)' END) AS detail`);
  await fix(q, 'CONTA_DA_INTENCAO', 'bank_account_id', `
    UPDATE ${FE} e SET bank_account_id = pi.bank_account_id
      FROM (SELECT DISTINCT ON (financial_entry_id) financial_entry_id, bank_account_id FROM finance.payment_intents
             WHERE bank_account_id IS NOT NULL ORDER BY financial_entry_id, updated_at DESC) pi
     WHERE pi.financial_entry_id = e.id AND e.bank_account_id IS NULL AND e.settlement_method IN ('BANK_CONFIRMED', 'SANDBOX_CONFIRMED')
    RETURNING e.id, e.company_id, NULL AS old_value, e.bank_account_id::text AS new_value`);
  await fix(q, 'VALOR_ZERO', 'ledger_exclusion_reason', `
    UPDATE ${FE} e SET ledger_exclusion_reason = '${REASON_ZERO}' WHERE e.amount <= 0 AND e.ledger_exclusion_reason IS NULL
    RETURNING e.id, e.company_id, NULL AS old_value, e.amount::text AS new_value, jsonb_build_object('status', e.status, 'parent', e.parent_entry_id) AS detail`);
  await fix(q, 'VALOR_ZERO_CANCELADO', 'status', `
    UPDATE ${FE} e SET status = 'CANCELLED' WHERE e.amount <= 0 AND e.status = 'PENDING' AND e.parent_entry_id IS NULL
    RETURNING e.id, e.company_id, 'PENDING' AS old_value, e.status AS new_value`);
  await fix(q, 'ESTORNO_DE_NAO_REALIZADO', 'ledger_exclusion_reason', `
    UPDATE ${FE} r SET ledger_exclusion_reason = '${REASON_NOT_REALIZED}'
      FROM ${FE} o
     WHERE r.reversal_of_entry_id = o.id AND r.ledger_exclusion_reason IS NULL AND o.settled_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM ${FE} c WHERE c.parent_entry_id = o.id AND ${CHILD})
    RETURNING r.id, r.company_id, NULL AS old_value, r.amount::text AS new_value, jsonb_build_object('estornado', o.id, 'status_do_estornado', o.status) AS detail`);
  await fixParentReversals(q);
  await fixDerivedStatus(q);
}

/** Sonda P3: estorno do valor cheio do pai com baixas -> fora do ledger, e o estorno de cada baixa ainda de pé no período corrente. */
async function fixParentReversals(q) {
  const [wrong] = await q(`
    SELECT r.id, r.company_id, r.reversal_of_entry_id AS parent_id, r.created_by FROM ${FE} r
     WHERE r.reversal_of_entry_id IS NOT NULL AND r.ledger_exclusion_reason IS NULL
       AND EXISTS (SELECT 1 FROM ${FE} c WHERE c.parent_entry_id = r.reversal_of_entry_id AND ${CHILD})`);
  for (const r of wrong) {
    await fix(q, 'ESTORNO_DO_PAI_SUBSTITUIDO', 'ledger_exclusion_reason', `
      UPDATE ${FE} SET ledger_exclusion_reason = '${REASON_PARENT}' WHERE id = '${r.id}'
      RETURNING id, company_id, NULL AS old_value, amount::text AS new_value, jsonb_build_object('pai', reversal_of_entry_id) AS detail`);
    const [created] = await q(`
      INSERT INTO ${FE} (id, group_id, company_id, bank_account_id, cost_center_id, result_center_id, contract_id, chart_of_account_id,
                         chart_of_account_version_id, construction_project_id, entry_type, nature, amount, description, due_at, competence_month,
                         settled_at, status, idempotency_key, reversal_of_entry_id, parent_entry_id, movement_kind, created_by, updated_by, created_at, updated_at)
      SELECT gen_random_uuid(), c.group_id, c.company_id, c.bank_account_id, c.cost_center_id, c.result_center_id, c.contract_id, c.chart_of_account_id,
             c.chart_of_account_version_id, c.construction_project_id, CASE WHEN c.entry_type = 'DEBIT' THEN 'CREDIT' ELSE 'DEBIT' END, 'ADJUSTMENT',
             c.amount - COALESCE((SELECT SUM(x.amount) FROM ${FE} x WHERE x.reversal_of_entry_id = c.id AND x.ledger_exclusion_reason IS NULL), 0),
             'Correção M4LR: estorno da baixa parcial (substitui o estorno do valor cheio do lançamento ' || c.parent_entry_id::text || ')',
             NULL, to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM'), now(), 'SETTLED',
             'reversal:' || c.id::text || ':correcao-m4lr', c.id, NULL, 'REVERSAL', COALESCE(:who, '${S.SYSTEM_ACTOR_ID}')::uuid, COALESCE(:who, '${S.SYSTEM_ACTOR_ID}')::uuid, now(), now()
        FROM ${FE} c
       WHERE c.parent_entry_id = :parent AND ${CHILD} AND c.status = 'SETTLED' AND c.ledger_exclusion_reason IS NULL
         AND c.amount > COALESCE((SELECT SUM(x.amount) FROM ${FE} x WHERE x.reversal_of_entry_id = c.id AND x.ledger_exclusion_reason IS NULL), 0)
      RETURNING id, company_id, reversal_of_entry_id, amount`, { parent: r.parent_id, who: r.created_by });
    for (const row of created) {
      await q(`INSERT INTO ${LOG} (step, company_id, entry_id, column_name, new_value, created_entry_id, detail) VALUES ('ESTORNO_CORRECAO', :c, :e, 'amount', :a, :n, CAST(:d AS jsonb))`,
        { c: row.company_id, e: row.reversal_of_entry_id, a: String(row.amount), n: row.id, d: JSON.stringify({ substitui: r.id }) });
      await q(`INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
               SELECT gen_random_uuid(), e.group_id, e.company_id, NULL, 'finance.entry.reverse', 'FinancialEntry', e.reversal_of_entry_id, '{}'::jsonb,
                      jsonb_build_object('reversalEntryId', e.id, 'ledgerEffect', 'CORRECAO_M4LR', 'substitui', CAST(:r AS text)), :reason, now(), now(), now()
                 FROM ${FE} e WHERE e.id = :id`,
      { id: row.id, r: r.id, reason: `Migration 20260101010520 (M4LR): estorno da baixa parcial ${row.reversal_of_entry_id} de ${row.amount}, no lugar do estorno do valor cheio ${r.id} do lançamento ${r.parent_id} (Caderno §6; ajuste no período corrente, §16).` });
      await fix(q, 'BAIXA_ESTORNADA_NA_CORRECAO', 'status', `
        UPDATE ${FE} SET status = 'REVERSED' WHERE id = '${row.reversal_of_entry_id}' AND status = 'SETTLED'
        RETURNING id, company_id, 'SETTLED' AS old_value, status AS new_value`);
    }
  }
}

/** Sondas P1/P4: status do pai pelo ledger (baixa estornada ou baixa de 0,00 não conta como realizado). */
async function fixDerivedStatus(q) {
  await fix(q, 'STATUS_DERIVADO', 'status', `
    WITH fam AS (
      SELECT p.id, p.status AS old_status, p.settled_at AS old_settled_at, p.amount,
             COALESCE((SELECT SUM(GREATEST(c.amount - COALESCE((SELECT SUM(x.amount) FROM ${FE} x WHERE x.reversal_of_entry_id = c.id AND x.ledger_exclusion_reason IS NULL), 0), 0))
                         FROM ${FE} c WHERE c.parent_entry_id = p.id AND c.movement_kind IN ('PARTIAL', 'COMPLEMENT') AND c.status IN ('SETTLED', 'REVERSED')
                          AND c.ledger_exclusion_reason IS NULL), 0) AS realized,
             (SELECT max(c.settled_at) FROM ${FE} c WHERE c.parent_entry_id = p.id AND c.movement_kind IN ('PARTIAL', 'COMPLEMENT')) AS last_settled_at
        FROM ${FE} p
       WHERE p.parent_entry_id IS NULL AND p.status IN ('PENDING', 'PARTIALLY_SETTLED', 'SETTLED') AND p.ledger_exclusion_reason IS NULL
         AND EXISTS (SELECT 1 FROM ${FE} c WHERE c.parent_entry_id = p.id AND c.movement_kind IN ('PARTIAL', 'COMPLEMENT'))),
    d AS (SELECT *, CASE WHEN realized <= 0 THEN 'PENDING' WHEN realized >= amount THEN 'SETTLED' ELSE 'PARTIALLY_SETTLED' END AS new_status FROM fam)
    UPDATE ${FE} p SET status = d.new_status,
                       settled_at = CASE WHEN d.new_status = 'SETTLED' THEN COALESCE(p.settled_at, d.last_settled_at) ELSE NULL END
      FROM d WHERE p.id = d.id AND d.new_status <> d.old_status
    RETURNING p.id, p.company_id, d.old_status AS old_value, d.new_status AS new_value,
              jsonb_build_object('settled_at_antes', d.old_settled_at, 'realizado', d.realized::text) AS detail`);
}

async function addConstraints(q) {
  await q(`ALTER TABLE ${FE} ALTER COLUMN idempotency_key SET NOT NULL`);
  await q(`ALTER TABLE ${FE} ALTER COLUMN created_by SET NOT NULL`);
  await q(`ALTER TABLE ${FE} ADD CONSTRAINT financial_entries_amount_positive_ck CHECK (amount > 0 OR ledger_exclusion_reason IS NOT NULL)`);
  await q(`ALTER TABLE ${FE} ADD CONSTRAINT financial_entries_movement_kind_ck CHECK (movement_kind IS NULL OR movement_kind IN ${MOVEMENT_KINDS_SQL})`);
  await q(`ALTER TABLE ${FE} ADD CONSTRAINT financial_entries_bank_confirmed_account_ck
             CHECK (settlement_method IS NULL OR settlement_method NOT IN ('BANK_CONFIRMED', 'SANDBOX_CONFIRMED') OR bank_account_id IS NOT NULL) NOT VALID`);
  const [[{ n }]] = await q(`SELECT count(*)::int AS n FROM ${FE} WHERE settlement_method IN ('BANK_CONFIRMED', 'SANDBOX_CONFIRMED') AND bank_account_id IS NULL`);
  if (n === 0) await q(`ALTER TABLE ${FE} VALIDATE CONSTRAINT financial_entries_bank_confirmed_account_ck`);
  else await q(`INSERT INTO ${LOG} (step, detail) VALUES ('CONTA_SEM_ORIGEM', CAST(:d AS jsonb))`, { d: JSON.stringify({ linhas: n, constraint: 'NOT VALID: vale para toda linha nova ou alterada' }) });
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS financial_entries_company_ledger_key_uk ON ${FE} (company_id, (COALESCE(settlement_idempotency_key, idempotency_key)))`);
  await q(S.FIELDS_TRIGGER);
  await q(`DROP TRIGGER IF EXISTS trg_financial_entries_ledger_fields ON ${FE}`);
  await q(`CREATE TRIGGER trg_financial_entries_ledger_fields BEFORE INSERT OR UPDATE ON ${FE} FOR EACH ROW EXECUTE FUNCTION finance.financial_entries_ledger_fields()`);
  // ALWAYS: vale também em carga com session_replication_role = replica (a chave e o autor são dado do NOT NULL, não regra de negócio).
  await q(`ALTER TABLE ${FE} ENABLE ALWAYS TRIGGER trg_financial_entries_ledger_fields`);
}

async function createLedgerView(q, sql) {
  await q(sql);
  await q('CREATE TRIGGER ledger_read_only INSTEAD OF INSERT OR UPDATE OR DELETE ON finance.ledger FOR EACH ROW EXECUTE FUNCTION finance.caderno_view_read_only()');
  await q("COMMENT ON VIEW finance.ledger IS 'Caderno M4 §5/§7 — movimentos realizados (view somente leitura, security_invoker) sobre finance.financial_entries.'");
  if (await runtimeExists(q)) await q('GRANT SELECT ON finance.ledger TO nayara_runtime');
}

async function up(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
    const [forced] = await q("SELECT oid::regclass::text AS t FROM pg_class WHERE oid = ANY (CAST(:t AS regclass[])) AND relforcerowsecurity", { t: `{${RLS_TABLES.join(',')}}` });
    for (const { t } of forced) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await q(`CREATE TABLE IF NOT EXISTS ${LOG} (id bigserial PRIMARY KEY, logged_at timestamptz NOT NULL DEFAULT now(), step varchar(40) NOT NULL, company_id uuid,
               entry_id uuid, column_name varchar(64), old_value text, new_value text, created_entry_id uuid, detail jsonb)`);
    // Tabela multiempresa (company_id): RLS + FORCE + isolamento por empresa, como as demais (o runtime nem tem acesso).
    await q(`ALTER TABLE ${LOG} ENABLE ROW LEVEL SECURITY`);
    await q(`ALTER TABLE ${LOG} NO FORCE ROW LEVEL SECURITY`); // FORCE no fim (a migration grava o log como dona)
    await q(`DROP POLICY IF EXISTS tenant_isolation ON ${LOG}`);
    await q(`CREATE POLICY tenant_isolation ON ${LOG} USING (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)
               WITH CHECK (company_id = NULLIF(current_setting('app.company_id', true), '')::uuid)`);
    await q(`REVOKE ALL ON ${LOG} FROM PUBLIC`);
    if (await runtimeExists(q)) await q(`REVOKE ALL ON ${LOG} FROM nayara_runtime`);
    await q(`ALTER TABLE ${FE} ADD COLUMN IF NOT EXISTS settlement_idempotency_key varchar(180) NULL,
               ADD COLUMN IF NOT EXISTS movement_kind varchar(20) NULL, ADD COLUMN IF NOT EXISTS ledger_exclusion_reason text NULL`);
    const before = await counts(q, "CASE WHEN l.direction = 'CREDIT' THEN l.amount ELSE -l.amount END");
    await logCounts(q, 'CONTAGEM_ANTES', before);
    await q('DROP VIEW IF EXISTS finance.ledger');
    await q(`ALTER TABLE ${FE} ALTER COLUMN idempotency_key TYPE varchar(180)`);
    await q(`ALTER TABLE ${FE} DISABLE TRIGGER trg_financial_entries_append_only`);
    await q(S.ROOT_FUNCTION);
    for (const fn of S.BALANCE_FUNCTIONS) await q(fn);
    await fixData(q);
    await q(`ALTER TABLE ${FE} ENABLE TRIGGER trg_financial_entries_append_only`);
    await addConstraints(q);
    await createLedgerView(q, S.LEDGER_VIEW);
    await q(S.BANK_TX_TRIGGER);
    await q('DROP TRIGGER IF EXISTS bank_transactions_immutable ON finance.bank_transactions');
    await q('CREATE TRIGGER bank_transactions_immutable BEFORE UPDATE OR DELETE ON finance.bank_transactions FOR EACH ROW EXECUTE FUNCTION finance.bank_transactions_immutable()');
    // DELETE revogado; UPDATE fica (o SELECT ... FOR UPDATE da conciliação precisa dele) e o gatilho recusa qualquer mudança de coluna.
    if (await runtimeExists(q)) await q('REVOKE DELETE ON finance.bank_transactions FROM nayara_runtime');
    const after = await counts(q, 'l.cash_amount');
    await logCounts(q, 'CONTAGEM_DEPOIS', after);
    await auditSummary(q, before, after);
    await q(`ALTER TABLE ${LOG} FORCE ROW LEVEL SECURITY`);
    for (const { t } of forced) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  });
}

async function down(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
    const [forced] = await q("SELECT oid::regclass::text AS t FROM pg_class WHERE oid = ANY (CAST(:t AS regclass[])) AND relforcerowsecurity", { t: `{${RLS_TABLES.join(',')}}` });
    for (const { t } of forced) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
    await q('DROP VIEW IF EXISTS finance.ledger');
    await q('DROP TRIGGER IF EXISTS bank_transactions_immutable ON finance.bank_transactions');
    await q('DROP FUNCTION IF EXISTS finance.bank_transactions_immutable()');
    if (await runtimeExists(q)) await q('GRANT DELETE ON finance.bank_transactions TO nayara_runtime');
    await q(`DROP TRIGGER IF EXISTS trg_financial_entries_ledger_fields ON ${FE}`);
    await q('DROP FUNCTION IF EXISTS finance.financial_entries_ledger_fields()');
    await q('DROP INDEX IF EXISTS finance.financial_entries_company_ledger_key_uk');
    for (const ck of ['financial_entries_amount_positive_ck', 'financial_entries_movement_kind_ck', 'financial_entries_bank_confirmed_account_ck']) {
      await q(`ALTER TABLE ${FE} DROP CONSTRAINT IF EXISTS ${ck}`);
    }
    await q(`ALTER TABLE ${FE} ALTER COLUMN idempotency_key DROP NOT NULL`);
    await q(`ALTER TABLE ${FE} ALTER COLUMN created_by DROP NOT NULL`);
    await q(`ALTER TABLE ${FE} DISABLE TRIGGER trg_financial_entries_append_only`);
    const [[{ exists }]] = await q("SELECT to_regclass(:t) IS NOT NULL AS exists", { t: LOG });
    if (exists) {
      await q(`ALTER TABLE ${LOG} NO FORCE ROW LEVEL SECURITY`);
      await q(`DELETE FROM ${FE} e USING ${LOG} l WHERE l.step = 'ESTORNO_CORRECAO' AND l.created_entry_id = e.id`);
      await q(`UPDATE ${FE} e SET status = l.old_value FROM ${LOG} l WHERE l.entry_id = e.id AND l.step IN ('BAIXA_ESTORNADA_NA_CORRECAO', 'VALOR_ZERO_CANCELADO')`);
      await q(`UPDATE ${FE} e SET status = l.old_value, settled_at = CAST(l.detail->>'settled_at_antes' AS timestamptz) FROM ${LOG} l WHERE l.entry_id = e.id AND l.step = 'STATUS_DERIVADO'`);
      await q(`UPDATE ${FE} e SET bank_account_id = NULL FROM ${LOG} l WHERE l.entry_id = e.id AND l.step = 'CONTA_DA_INTENCAO'`);
      await q(`UPDATE ${FE} e SET created_by = NULL FROM ${LOG} l WHERE l.entry_id = e.id AND l.step = 'AUTOR'`);
      await q(`UPDATE ${FE} e SET idempotency_key = NULL FROM ${LOG} l WHERE l.entry_id = e.id AND l.step = 'CHAVE_LEGADO'`);
    }
    await q(`ALTER TABLE ${FE} ENABLE TRIGGER trg_financial_entries_append_only`);
    await q(`ALTER TABLE ${FE} ALTER COLUMN idempotency_key TYPE varchar(128)`);
    await q(`ALTER TABLE ${FE} DROP COLUMN IF EXISTS settlement_idempotency_key, DROP COLUMN IF EXISTS movement_kind, DROP COLUMN IF EXISTS ledger_exclusion_reason`);
    await q('DROP FUNCTION IF EXISTS finance.ledger_root_entry_id(uuid)');
    await q('DROP FUNCTION IF EXISTS finance.entry_realized_by_children(uuid)');
    await q('DROP FUNCTION IF EXISTS finance.entry_has_settlement_children(uuid)');
    await createLedgerView(q, S.LEGACY_LEDGER_VIEW);
    await q(`DROP TABLE IF EXISTS ${LOG}`);
    for (const { t } of forced) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
  });
}

module.exports = { up, down, LOG };
