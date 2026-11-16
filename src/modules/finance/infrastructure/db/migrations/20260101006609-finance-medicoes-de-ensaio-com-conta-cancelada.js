'use strict';

const { forceRestaurado } = require('../../../../../shared/db/forceRestaurado');

/**
 * Medições de ENSAIO DE FALHA presas em PAYABLE sem a conta a pagar (decisão do Patrick, 16/11/2026: não apagar, informar o motivo).
 *
 * Na homologação havia 29 medições assim, todas da obra "FAILURE DRILL — Obra <n>" (teste test/construction.failureDrills.test.js, Drill 3:
 * duas aprovações simultâneas da mesma medição de R$ 999,99), de 08 a 16/10/2026, quando a suíte ainda rodava contra o banco da homologação:
 * o teste aprovava a medição, o Financeiro criava a conta a pagar e a limpeza do teste apagava a conta, deixando a medição PAYABLE sem conta.
 * Nenhum lançamento as cita (conferido no backup de 13/11/2026). A regra do Marco 6 (CHECK stage_measurements_payable_has_entry, 20260101006603)
 * exige que medição PAYABLE aponte para a conta a pagar.
 *
 * Aqui, para cada uma: a conta a pagar é RECRIADA como o consumidor do Financeiro a cria (measurement-payable.consumer.js: DEBIT/PAYABLE, mesmo
 * valor, chave measurement.payable:<id>, obra) e já CANCELADA, com o motivo na descrição e na auditoria (o mesmo registro do cancelamento de
 * lançamento pendente, finance.entry.cancel_pending): nunca liquidada, sem movimento de caixa, não entra em indicador. A medição passa a apontar
 * para ela e a auditoria da medição registra o motivo. Nada é apagado. Só entra medição com a assinatura do ensaio (obra "FAILURE DRILL%" e
 * PAYABLE sem conta); qualquer outra fica como está e aparece no log (decisão caso a caso). Sem nenhuma sobrando, a CHECK é validada.
 * O down desfaz só o vínculo da medição; a conta cancelada fica (lançamento é append-only).
 */
const TABELAS = ['construction.stage_measurements', 'finance.financial_entries', 'audit.audit_log'];
const MOTIVO = 'Dado de ensaio de falha (teste automatizado de Obras, 10/2026) que rodou contra a homologação: a conta a pagar original foi apagada '
  + 'pela limpeza do teste e a medição ficou "a pagar" sem conta. Conta recriada já cancelada (nunca liquidada, sem movimento de caixa) para manter a '
  + 'regra "medição a pagar sempre tem conta" sem apagar registro. Decisão do Patrick em 16/11/2026.';
// A descrição do lançamento tem 255 caracteres: lá vai o motivo curto; o completo fica na auditoria.
const MOTIVO_CURTO = 'ensaio de falha de 10/2026; a conta original foi apagada pela limpeza do teste.';
const DO_ENSAIO = `m.status = 'PAYABLE' AND m.payable_financial_entry_id IS NULL
  AND EXISTS (SELECT 1 FROM construction.project_stages s JOIN construction.projects p ON p.id = s.project_id
               WHERE s.id = m.project_stage_id AND p.name LIKE 'FAILURE DRILL%')`;

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });
      const [linhas] = await q(`SELECT n.nspname || '.' || c.relname AS tabela FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE (n.nspname || '.' || c.relname) IN (:tabelas) AND c.relforcerowsecurity`, { tabelas: TABELAS });
      const forcadas = linhas.map((l) => l.tabela);
      for (const t of forcadas) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await forceRestaurado(async () => {
        const [medicoes] = await q(`SELECT m.id, m.group_id, m.company_id, m.total_amount, m.cost_center_id, s.name AS etapa, s.project_id,
            COALESCE(m.approved_at, m.updated_at) AS aprovada_em,
            COALESCE((SELECT a.user_id FROM audit.audit_log a WHERE a.entity_id = m.id AND a.action = 'construction.stage_measurement.decide'
                       AND a.user_id IS NOT NULL ORDER BY a.occurred_at DESC LIMIT 1), m.created_by) AS autor
          FROM construction.stage_measurements m JOIN construction.project_stages s ON s.id = m.project_stage_id
         WHERE ${DO_ENSAIO} ORDER BY m.created_at`);
        let semAutor = 0;
        for (const m of medicoes) {
          if (!m.autor) { semAutor += 1; continue; }
          const r = { ...m, motivo: MOTIVO, chave: `measurement.payable:${m.id}`,
            descricao: `Medição aprovada — etapa "${String(m.etapa).slice(0, 40)}" (medição ${m.id}). CANCELADA: ${MOTIVO_CURTO}` };
          const [[conta]] = await q(`INSERT INTO finance.financial_entries (id, group_id, company_id, entry_type, nature, amount, status, idempotency_key,
              description, construction_project_id, cost_center_id, competence_month, created_by, updated_by, created_at, updated_at)
            VALUES (gen_random_uuid(), :group_id, :company_id, 'DEBIT', 'PAYABLE', :total_amount, 'CANCELLED', :chave, :descricao, :project_id,
              :cost_center_id, to_char(CAST(:aprovada_em AS timestamptz) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM'), :autor, :autor, now(), now())
            RETURNING id`, r);
          await q(`INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
            VALUES (gen_random_uuid(), :group_id, :company_id, :autor, 'finance.entry.cancel_pending', 'FinancialEntry', :conta, NULL,
              jsonb_build_object('status', 'CANCELLED', 'amount', CAST(:total_amount AS numeric), 'idempotencyKey', CAST(:chave AS text), 'measurementId', CAST(:id AS text), 'migration', '20260101006609'),
              :motivo, now(), now(), now())`, { ...r, conta: conta.id });
          await q('UPDATE construction.stage_measurements SET payable_financial_entry_id = :conta, updated_at = now() WHERE id = :id', { conta: conta.id, id: m.id });
          await q(`INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
            VALUES (gen_random_uuid(), :group_id, :company_id, :autor, 'construction.stage_measurement.payable_relinked', 'StageMeasurement', :id,
              jsonb_build_object('payableFinancialEntryId', NULL::text), jsonb_build_object('payableFinancialEntryId', CAST(:conta AS text), 'migration', '20260101006609'),
              :motivo, now(), now(), now())`, { ...r, conta: conta.id });
        }
        const [[sobra]] = await q("SELECT count(*)::int AS n FROM construction.stage_measurements WHERE status = 'PAYABLE' AND payable_financial_entry_id IS NULL");
        const [[chk]] = await q("SELECT convalidated FROM pg_constraint WHERE conname = 'stage_measurements_payable_has_entry'");
        if (chk && !chk.convalidated && sobra.n === 0) await q('ALTER TABLE construction.stage_measurements VALIDATE CONSTRAINT stage_measurements_payable_has_entry');
        console.log(`[20260101006609] medições de ensaio de falha PAYABLE sem conta: ${medicoes.length - semAutor} com a conta recriada já cancelada`
          + (semAutor ? `, ${semAutor} sem autor conhecido (ficaram como estavam)` : '')
          + `; PAYABLE sem conta que sobraram: ${sobra.n}` + (sobra.n ? ' — CHECK continua sem validar (decisão caso a caso).' : ' — CHECK validada.'));
      }, async () => { for (const t of forcadas) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); });
    });
  },

  async down(queryInterface) {
    // Desfaz só o vínculo da medição (volta ao estado de antes); a conta cancelada e a auditoria ficam: lançamento é append-only.
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql) => queryInterface.sequelize.query(sql, { transaction });
      await q('ALTER TABLE construction.stage_measurements DROP CONSTRAINT IF EXISTS stage_measurements_payable_has_entry');
      await q(`UPDATE construction.stage_measurements m SET payable_financial_entry_id = NULL
                 FROM finance.financial_entries e
                WHERE e.id = m.payable_financial_entry_id AND e.status = 'CANCELLED' AND e.description LIKE '%(medição ' || m.id::text || '). CANCELADA:%'`);
      await q(`ALTER TABLE construction.stage_measurements ADD CONSTRAINT stage_measurements_payable_has_entry
                 CHECK (status <> 'PAYABLE' OR payable_financial_entry_id IS NOT NULL) NOT VALID`);
    });
  },
};
