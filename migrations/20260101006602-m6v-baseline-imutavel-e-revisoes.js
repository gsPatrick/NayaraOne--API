'use strict';

const { applyLegalTenantRls } = require('./_helpers/legalTenantTable');

/**
 * Verificação independente do Marco 6 (M6-17, M6-82 e M6-42). Guia do Marcelo §3: "approveBudget(): ... freezeBaseline
 * ... Nunca UPDATE no baseline aprovado." Guia §15: "Não editar baseline". Caderno §2: "mudança somente por Change Order
 * aprovado".
 *
 * Até aqui o Change Order aprovado fazia UPDATE em budgets.baseline_amount/total_amount e em projects.budget_amount, e o
 * painel somava o aditivo duas vezes (baselineBudget já com o aditivo + approvedChanges). Esta migration:
 *  1. cria construction.budget_revisions, append-only: cada Change Order aprovado vira UMA revisão nova (número,
 *     total anterior, impacto e total novo), sem tocar na baseline;
 *  2. corrige os dados que já existem: para cada orçamento aprovado com Change Orders aprovados, a baseline volta ao
 *     valor congelado na aprovação (baseline gravada − soma dos aditivos aprovados), o orçamento da obra
 *     (projects.budget_amount) idem, e cada aditivo aprovado vira a sua revisão, na ordem da decisão. Cada linha
 *     corrigida deixa um registro em audit.audit_log com antes e depois;
 *  3. instala as travas no banco: a baseline de um orçamento APPROVED não muda mais por UPDATE (gatilho), e a tabela
 *     de revisões recusa UPDATE e DELETE.
 * RLS: NO FORCE só durante a correção (mesmo padrão de 20260101009975). O down remove as travas e a tabela, mas não
 * desfaz a correção dos dados (os valores anteriores estão no audit_log, action construction.budget.baseline_restored).
 */
const REV = 'construction.budget_revisions';
const TABLES_NO_FORCE = ['construction.budgets', 'construction.projects', 'construction.change_orders', REV, 'audit.audit_log'];

async function auditar(q, row, entityType, entityId, before, after, reason) {
  await q(
    `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
     VALUES (gen_random_uuid(), :g, :c, NULL, 'construction.budget.baseline_restored', :t, :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`,
    { g: row.group_id, c: row.company_id, t: entityType, id: entityId, b: JSON.stringify(before), a: JSON.stringify(after), r: reason }
  );
}

async function corrigirDados(q) {
  const [orcamentos] = await q(`SELECT b.id, b.group_id, b.company_id, b.project_id, b.baseline_amount::numeric AS baseline, b.total_amount::numeric AS total,
      p.budget_amount::numeric AS project_budget,
      (SELECT COALESCE(SUM(co.budget_impact), 0) FROM construction.change_orders co
        WHERE co.project_id = b.project_id AND co.status = 'APPROVED' AND co.deleted_at IS NULL)::numeric AS aditivos
    FROM construction.budgets b JOIN construction.projects p ON p.id = b.project_id
    WHERE b.status = 'APPROVED' AND b.deleted_at IS NULL`);
  for (const o of orcamentos) {
    const [cos] = await q(
      `SELECT id, budget_impact::numeric AS impacto, decided_at, decided_by FROM construction.change_orders
        WHERE project_id = :p AND status = 'APPROVED' AND deleted_at IS NULL ORDER BY decided_at ASC NULLS LAST, created_at ASC`,
      { p: o.project_id }
    );
    if (!cos.length) continue;
    const original = Number(o.baseline) - Number(o.aditivos);
    const motivo = `Migration 20260101006602 (DI-M6V-3): a baseline aprovada volta ao valor congelado na aprovação; os ${cos.length} Change Order(s) aprovados viram revisões append-only.`;
    if (original >= 0) {
      await q('UPDATE construction.budgets SET baseline_amount = :v, total_amount = :v, updated_at = now() WHERE id = :id', { v: original.toFixed(2), id: o.id });
      await auditar(q, o, 'Budget', o.id, { baselineAmount: o.baseline, totalAmount: o.total }, { baselineAmount: original.toFixed(2), totalAmount: original.toFixed(2) }, motivo);
      if (o.project_budget !== null && Number(o.project_budget) === Number(o.baseline)) {
        await q('UPDATE construction.projects SET budget_amount = :v, updated_at = now() WHERE id = :id', { v: original.toFixed(2), id: o.project_id });
        await auditar(q, o, 'Project', o.project_id, { budgetAmount: o.project_budget }, { budgetAmount: original.toFixed(2) }, motivo);
      }
    }
    let total = original;
    let n = 0;
    for (const co of cos) {
      const [[existe]] = await q(`SELECT id FROM ${REV} WHERE change_order_id = :co`, { co: co.id });
      if (existe) continue;
      n += 1;
      const novo = total + Number(co.impacto);
      const [[rev]] = await q(
        `INSERT INTO ${REV} (id, group_id, company_id, budget_id, project_id, revision_number, change_order_id, previous_total, budget_impact, new_total, reason, created_by, created_at)
         VALUES (gen_random_uuid(), :g, :c, :b, :p, :n, :co, :prev, :imp, :novo, :r, :by, COALESCE(:at, now())) RETURNING id`,
        { g: o.group_id, c: o.company_id, b: o.id, p: o.project_id, n, co: co.id, prev: total.toFixed(2), imp: Number(co.impacto).toFixed(2), novo: novo.toFixed(2), r: 'Revisão criada pela correção da baseline (aditivo aprovado antes da trava).', by: co.decided_by, at: co.decided_at }
      );
      await auditar(q, o, 'BudgetRevision', rev.id, null, { revisionNumber: n, changeOrderId: co.id, previousTotal: total.toFixed(2), newTotal: novo.toFixed(2) }, motivo);
      total = novo;
    }
  }
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q(`CREATE TABLE IF NOT EXISTS ${REV} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES core.groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        company_id uuid NOT NULL REFERENCES core.companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        budget_id uuid NOT NULL REFERENCES construction.budgets(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        project_id uuid NOT NULL REFERENCES construction.projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        revision_number integer NOT NULL CHECK (revision_number >= 1),
        change_order_id uuid NULL REFERENCES construction.change_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        previous_total numeric(18,2) NOT NULL,
        budget_impact numeric(18,2) NOT NULL,
        new_total numeric(18,2) NOT NULL CHECK (new_total >= 0),
        reason text NULL,
        created_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT budget_revisions_number_unique UNIQUE (budget_id, revision_number),
        CONSTRAINT budget_revisions_change_order_unique UNIQUE (change_order_id)
      )`);
      await applyLegalTenantRls(q, REV, 'SELECT, INSERT');

      for (const t of TABLES_NO_FORCE) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      try {
        await corrigirDados(q);
      } finally {
        for (const t of TABLES_NO_FORCE) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
      }

      await q(`CREATE OR REPLACE FUNCTION construction.budget_revisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          RAISE EXCEPTION 'construction.budget_revisions é append-only: revisão de orçamento não é alterada nem apagada' USING ERRCODE = 'P0001';
        END $f$`);
      await q(`DROP TRIGGER IF EXISTS budget_revisions_append_only ON ${REV}`);
      await q(`CREATE TRIGGER budget_revisions_append_only BEFORE UPDATE OR DELETE ON ${REV}
        FOR EACH ROW EXECUTE FUNCTION construction.budget_revisions_append_only()`);

      await q(`CREATE OR REPLACE FUNCTION construction.budgets_baseline_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          IF OLD.status = 'APPROVED' AND (
               NEW.baseline_amount IS DISTINCT FROM OLD.baseline_amount OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
            OR NEW.rule_version_id IS DISTINCT FROM OLD.rule_version_id OR NEW.status IS DISTINCT FROM OLD.status
            OR NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
            OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
            RAISE EXCEPTION 'baseline aprovada é imutável: mudança só por Change Order aprovado (revisão nova)' USING ERRCODE = 'P0001';
          END IF;
          RETURN NEW;
        END $f$`);
      await q('DROP TRIGGER IF EXISTS budgets_baseline_immutable ON construction.budgets');
      await q(`CREATE TRIGGER budgets_baseline_immutable BEFORE UPDATE ON construction.budgets
        FOR EACH ROW EXECUTE FUNCTION construction.budgets_baseline_immutable()`);
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql) => sequelize.query(sql, { transaction });
      await q('DROP TRIGGER IF EXISTS budgets_baseline_immutable ON construction.budgets');
      await q('DROP FUNCTION IF EXISTS construction.budgets_baseline_immutable()');
      await q(`DROP TRIGGER IF EXISTS budget_revisions_append_only ON ${REV}`);
      await q('DROP FUNCTION IF EXISTS construction.budget_revisions_append_only()');
      await q(`DROP TABLE IF EXISTS ${REV}`);
    });
  },
};
