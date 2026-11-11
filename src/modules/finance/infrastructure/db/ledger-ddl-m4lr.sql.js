'use strict';

/**
 * SQL do DDL mínimo do ledger (Caderno M4 §7) usado pela migration 20260101010520 (fica fora da pasta migrations/ para o
 * executor não o tratar como migration). Só texto SQL: a ordem e os dados estão em ledger-ddl-m4lr.data.js.
 */

// Ator das linhas gravadas por automação (job, webhook, carga) sem usuário humano: created_by NOT NULL (§7) sem inventar
// pessoa. Não é usuário que entra no sistema (não existe em core.users); a tela mostra "Sistema (automação)".
const SYSTEM_ACTOR_ID = '00000000-0000-4000-a000-00000000f1a0';

const SETTLEMENT_CHILD_SQL = (alias) => `(${alias}.movement_kind IN ('PARTIAL', 'COMPLEMENT') OR (${alias}.movement_kind IS NULL AND ${alias}.nature <> 'PENDING_CLASSIFICATION'))`;

/** Raiz de uma cadeia de estornos (o movimento original): estorno de estorno aponta para o lançamento de origem. */
const ROOT_FUNCTION = `
CREATE OR REPLACE FUNCTION finance.ledger_root_entry_id(p_id uuid) RETURNS uuid LANGUAGE sql STABLE AS $f$
  WITH RECURSIVE chain(id, reversal_of, depth) AS (
    SELECT e.id, e.reversal_of_entry_id, 0 FROM finance.financial_entries e WHERE e.id = p_id
    UNION ALL
    SELECT f.id, f.reversal_of_entry_id, c.depth + 1 FROM finance.financial_entries f JOIN chain c ON f.id = c.reversal_of WHERE c.depth < 64
  )
  SELECT id FROM chain ORDER BY depth DESC LIMIT 1
$f$`;

/**
 * Regra única do saldo (Caderno §6): a baixa filha que baixa o pai (parcial ou complemento; o excedente não), quanto as baixas
 * realizaram (cada uma menos os estornos que apontam para ela) e se o lançamento tem baixas filhas (então ele não é linha do
 * ledger: as filhas é que são). Funções do banco para o Financeiro, a NAY e o read model do BI usarem a MESMA conta.
 */
const BALANCE_FUNCTIONS = [`
CREATE OR REPLACE FUNCTION finance.entry_realized_by_children(p_id uuid) RETURNS numeric LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(SUM(GREATEST(c.amount - COALESCE((SELECT SUM(x.amount) FROM finance.financial_entries x
                                                     WHERE x.reversal_of_entry_id = c.id AND x.ledger_exclusion_reason IS NULL), 0), 0)), 0)
    FROM finance.financial_entries c
   WHERE c.parent_entry_id = p_id AND c.status IN ('SETTLED', 'REVERSED') AND c.ledger_exclusion_reason IS NULL
     AND ${SETTLEMENT_CHILD_SQL('c')}
$f$`, `
CREATE OR REPLACE FUNCTION finance.entry_has_settlement_children(p_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $f$
  SELECT EXISTS (SELECT 1 FROM finance.financial_entries c WHERE c.parent_entry_id = p_id AND ${SETTLEMENT_CHILD_SQL('c')})
$f$`];

/**
 * finance.ledger (Caderno §7): só movimento realizado. O pai com baixas filhas não é linha (as filhas é que são); linha
 * com ledger_exclusion_reason (legado de 0,00 ou estorno de previsto não realizado) fica fora. O estorno herda da raiz a
 * natureza de negócio, o terceiro e as dimensões; financial_entry_id do estorno é o lançamento da raiz. source_event_id é o
 * evento de domínio (outbox) do movimento. Colunas além do DDL do livro servem os relatórios (§19) e a NAY (§18).
 */
const LEDGER_VIEW = `
CREATE VIEW finance.ledger WITH (security_invoker = true) AS
SELECT e.id, e.group_id, e.company_id,
       COALESCE(r.parent_entry_id, r.id, e.parent_entry_id, e.id) AS financial_entry_id,
       e.bank_account_id,
       (CASE WHEN e.reversal_of_entry_id IS NOT NULL THEN 'REVERSAL'
             WHEN e.movement_kind = 'COMPLEMENT' THEN 'COMPLEMENT_' || e.nature
             WHEN e.parent_entry_id IS NOT NULL THEN 'PARTIAL_' || e.nature
             ELSE e.nature END)::varchar(30) AS movement_type,
       e.entry_type::varchar(10) AS direction,
       e.amount,
       'BRL'::char(3) AS currency,
       COALESCE(e.settlement_idempotency_key, e.idempotency_key)::varchar(180) AS idempotency_key,
       e.settled_at AS occurred_at,
       e.reversal_of_entry_id AS reverses_ledger_id,
       COALESCE(r.is_third_party_funds, e.is_third_party_funds) AS is_third_party_funds,
       e.created_by,
       e.created_at,
       ev.id AS source_event_id,
       COALESCE(r.nature, e.nature)::varchar(32) AS business_nature,
       e.status::varchar(32) AS entry_status,
       e.parent_entry_id,
       COALESCE(r.cost_center_id, e.cost_center_id) AS cost_center_id,
       COALESCE(r.result_center_id, e.result_center_id) AS result_center_id,
       COALESCE(r.contract_id, e.contract_id) AS contract_id,
       e.competence_month,
       e.settlement_method,
       COALESCE(r.construction_project_id, e.construction_project_id) AS construction_project_id,
       COALESCE(r.third_party_reference, e.third_party_reference) AS third_party_reference,
       COALESCE(r.third_party_release_type, e.third_party_release_type) AS third_party_release_type,
       COALESCE(r.third_party_origin_entry_id, e.third_party_origin_entry_id) AS third_party_origin_entry_id,
       (CASE WHEN e.entry_type = 'CREDIT' THEN e.amount ELSE -e.amount END) AS cash_amount
  FROM finance.financial_entries e
  LEFT JOIN finance.financial_entries r ON e.reversal_of_entry_id IS NOT NULL AND r.id = finance.ledger_root_entry_id(e.id)
  LEFT JOIN LATERAL (
    SELECT o.id FROM integration.outbox_events o
     WHERE o.idempotency_key = CASE WHEN e.reversal_of_entry_id IS NULL THEN 'finance.entry.settled:' || e.id::text
                                    ELSE 'finance.entry.reversed:' || e.reversal_of_entry_id::text END
     LIMIT 1
  ) ev ON true
 WHERE e.status IN ('SETTLED', 'REVERSED') AND e.settled_at IS NOT NULL
   AND e.ledger_exclusion_reason IS NULL
   AND NOT EXISTS (SELECT 1 FROM finance.financial_entries c WHERE c.parent_entry_id = e.id AND ${SETTLEMENT_CHILD_SQL('c')})`;

/** Definição anterior (migration 560), recriada pelo down. */
const LEGACY_LEDGER_VIEW = `
CREATE VIEW finance.ledger WITH (security_invoker = true) AS
SELECT e.id, e.group_id, e.company_id, COALESCE(e.parent_entry_id, e.id) AS financial_entry_id,
       e.bank_account_id,
       CASE WHEN e.reversal_of_entry_id IS NOT NULL THEN 'REVERSAL'
            WHEN e.parent_entry_id IS NOT NULL THEN 'PARTIAL_' || e.nature
            ELSE e.nature END AS movement_type,
       e.entry_type AS direction, e.amount, 'BRL'::char(3) AS currency, e.idempotency_key,
       e.settled_at AS occurred_at, e.reversal_of_entry_id AS reverses_ledger_id,
       e.is_third_party_funds, e.created_by, e.created_at
  FROM finance.financial_entries e
 WHERE e.status IN ('SETTLED', 'REVERSED') AND e.settled_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM finance.financial_entries c WHERE c.parent_entry_id = e.id)`;

/**
 * Gatilho das colunas do ledger: no INSERT preenche a chave (`lancamento:<id>`) e o autor (usuário do contexto ou ator de
 * sistema) e recusa ledger_exclusion_reason (só esta migration grava); no UPDATE recusa mudar o motivo de exclusão, o tipo
 * do movimento e a chave do movimento depois de gravada.
 */
const FIELDS_TRIGGER = `
CREATE OR REPLACE FUNCTION finance.financial_entries_ledger_fields() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE ctx_user text := NULLIF(current_setting('app.user_id', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ledger_exclusion_reason IS NOT NULL THEN
      RAISE EXCEPTION 'finance.financial_entries: ledger_exclusion_reason é só da migration de legado (Caderno M4 §7).' USING ERRCODE = '23514';
    END IF;
    IF NEW.idempotency_key IS NULL THEN NEW.idempotency_key := 'lancamento:' || NEW.id::text; END IF;
    IF NEW.created_by IS NULL THEN
      NEW.created_by := CASE WHEN ctx_user ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN ctx_user::uuid
                             ELSE '${SYSTEM_ACTOR_ID}'::uuid END;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.ledger_exclusion_reason IS DISTINCT FROM OLD.ledger_exclusion_reason THEN
    RAISE EXCEPTION 'finance.financial_entries: ledger_exclusion_reason não pode ser alterado (id=%).', OLD.id USING ERRCODE = '23514';
  END IF;
  IF NEW.movement_kind IS DISTINCT FROM OLD.movement_kind THEN
    RAISE EXCEPTION 'finance.financial_entries: movement_kind não pode ser alterado (id=%).', OLD.id USING ERRCODE = '23514';
  END IF;
  IF OLD.settlement_idempotency_key IS NOT NULL AND NEW.settlement_idempotency_key IS DISTINCT FROM OLD.settlement_idempotency_key THEN
    RAISE EXCEPTION 'finance.financial_entries: a chave do movimento (settlement_idempotency_key) não muda depois de gravada (id=%).', OLD.id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $f$`;

/**
 * Caderno §5 "Extrato importado imutável": a linha do extrato não muda nem some pelo papel de runtime. O dono da tabela
 * (migração/manutenção do banco) continua podendo, como nas demais tabelas append-only.
 */
const BANK_TX_TRIGGER = `
CREATE OR REPLACE FUNCTION finance.bank_transactions_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
DECLARE owner_role name;
BEGIN
  SELECT pg_get_userbyid(c.relowner) INTO owner_role FROM pg_class c WHERE c.oid = TG_RELID;
  IF pg_has_role(current_user, owner_role, 'MEMBER') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finance.bank_transactions é o extrato importado imutável (Caderno M4 §5): DELETE não é permitido (id=%).', OLD.id USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - 'updated_at' - 'updated_by') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'updated_by') THEN
    RAISE EXCEPTION 'finance.bank_transactions é o extrato importado imutável (Caderno M4 §5): a linha não pode ser alterada (id=%).', OLD.id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $f$`;

module.exports = { SYSTEM_ACTOR_ID, SETTLEMENT_CHILD_SQL, ROOT_FUNCTION, BALANCE_FUNCTIONS, LEDGER_VIEW, LEGACY_LEDGER_VIEW, FIELDS_TRIGGER, BANK_TX_TRIGGER };
