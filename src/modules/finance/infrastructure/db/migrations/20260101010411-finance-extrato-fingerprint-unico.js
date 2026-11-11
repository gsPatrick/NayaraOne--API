'use strict';

/**
 * Guia M4 §10 "Importação bancária idempotente": `UNIQUE(bank_account_id, fingerprint)` — sem condição. A migration 20260101009985 criou o índice
 * PARCIAL (só linhas com id externo): a mesma linha sem id externo entrava duas vezes (sonda V2-P4 do verificador). Esta migration troca pelo índice
 * único completo.
 *
 * Antes do índice, as duplicatas já gravadas (mesma conta e mesmo fingerprint) são tratadas SEM apagar nada: a mais antiga (created_at, id) fica com o
 * fingerprint; cada uma das outras recebe um fingerprint de desambiguação `sha256(fingerprint || '|dup|' || id)` e uma linha em audit.audit_log
 * (`finance.bank_transaction.fingerprint_disambiguated`, antes e depois, com a linha mantida) para a equipe conferir se é extrato duplicado.
 * Contagem conferida: o número de linhas da tabela não muda e, depois, não resta nenhum par repetido. Um resumo por empresa vai para a trilha
 * (`finance.bank_transaction.fingerprint_unique_migration`). O `down` devolve os fingerprints originais pela trilha e recria o índice parcial.
 *
 * Gatilhos de UPDATE da tabela (ex.: imutabilidade do extrato) ficam desligados só durante a correção do fingerprint, dentro da transação, e voltam ao
 * modo exato de antes (ENABLE / ENABLE ALWAYS / ENABLE REPLICA).
 */
const AUDIT = `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
  VALUES (gen_random_uuid(), :g, :c, NULL, :action, :tipo, :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`;
const TABLES = ['finance.bank_transactions', 'audit.audit_log'];
const ACTION_ROW = 'finance.bank_transaction.fingerprint_disambiguated';
const ACTION_SUMMARY = 'finance.bank_transaction.fingerprint_unique_migration';

async function withoutForcedRls(q, fn) {
  const [rows] = await q(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE c.relforcerowsecurity AND (n.nspname || '.' || c.relname) IN (:t)`, { t: TABLES });
  const forced = rows.map((r) => r.t);
  for (const t of forced) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
  try { return await fn(); } finally { for (const t of forced) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); }
}

/** Desliga os gatilhos de UPDATE (não internos) de bank_transactions durante `fn` e os religa no mesmo modo. */
async function withoutUpdateTriggers(q, fn) {
  const [triggers] = await q(`SELECT tgname, tgenabled FROM pg_trigger
                               WHERE tgrelid = 'finance.bank_transactions'::regclass AND NOT tgisinternal AND tgenabled <> 'D' AND (tgtype & 16) <> 0`);
  for (const t of triggers) await q(`ALTER TABLE finance.bank_transactions DISABLE TRIGGER "${t.tgname}"`);
  try { return await fn(); } finally {
    const modo = { O: 'ENABLE', A: 'ENABLE ALWAYS', R: 'ENABLE REPLICA' };
    for (const t of triggers) await q(`ALTER TABLE finance.bank_transactions ${modo[t.tgenabled] || 'ENABLE'} TRIGGER "${t.tgname}"`);
  }
}

async function counts(q) {
  const [[c]] = await q(`SELECT count(*)::int AS linhas,
                                (SELECT count(*)::int FROM (SELECT 1 FROM finance.bank_transactions GROUP BY bank_account_id, fingerprint HAVING count(*) > 1) d) AS pares_repetidos
                           FROM finance.bank_transactions`);
  return c;
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
      await withoutForcedRls(q, async () => {
        const antes = await counts(q);
        const [dups] = await q(`SELECT id, group_id, company_id, bank_account_id, fingerprint, kept_id FROM (
                                  SELECT t.*, first_value(id) OVER w AS kept_id, row_number() OVER w AS n
                                    FROM finance.bank_transactions t
                                  WINDOW w AS (PARTITION BY bank_account_id, fingerprint ORDER BY created_at, id)) x
                                 WHERE n > 1 ORDER BY company_id, bank_account_id, created_at, id`);
        await withoutUpdateTriggers(q, async () => {
          for (const d of dups) {
            const [[{ novo }]] = await q("SELECT encode(sha256(convert_to(:fp || '|dup|' || :id, 'UTF8')), 'hex') AS novo", { fp: d.fingerprint, id: d.id });
            await q('UPDATE finance.bank_transactions SET fingerprint = :novo WHERE id = :id AND fingerprint = :fp', { novo, id: d.id, fp: d.fingerprint });
            await q(AUDIT, {
              g: d.group_id, c: d.company_id, action: ACTION_ROW, tipo: 'BankTransaction', id: d.id,
              b: JSON.stringify({ fingerprint: d.fingerprint, bankAccountId: d.bank_account_id }),
              a: JSON.stringify({ fingerprint: novo, bankAccountId: d.bank_account_id, keptBankTransactionId: d.kept_id }),
              r: 'Migration 20260101010411 (Guia M4 §10 UNIQUE(bank_account_id, fingerprint)): linha de extrato repetida (mesma conta e fingerprint de outra mais antiga). Nada apagado; conferir se o extrato foi importado em dobro.',
            });
          }
        });
        const depois = await counts(q);
        if (depois.linhas !== antes.linhas || depois.pares_repetidos !== 0) {
          throw new Error(`UNIQUE fingerprint: antes ${JSON.stringify(antes)}, depois ${JSON.stringify(depois)} — abortado.`);
        }
        const porEmpresa = new Map();
        for (const d of dups) porEmpresa.set(d.company_id, { g: d.group_id, n: (porEmpresa.get(d.company_id)?.n || 0) + 1 });
        for (const [companyId, { g, n }] of porEmpresa) {
          await q(AUDIT, {
            g, c: companyId, action: ACTION_SUMMARY, tipo: 'BankTransaction', id: null,
            b: JSON.stringify({ linhasNaTabela: antes.linhas, paresRepetidosNaTabela: antes.pares_repetidos }),
            a: JSON.stringify({ linhasNaTabela: depois.linhas, paresRepetidosNaTabela: 0, linhasDesambiguadasNaEmpresa: n }),
            r: 'Migration 20260101010411: duplicatas de fingerprint tratadas antes do índice único completo.',
          });
        }
        await q('DROP INDEX IF EXISTS finance.bank_transactions_account_fingerprint_uk');
        await q('CREATE UNIQUE INDEX bank_transactions_account_fingerprint_uk ON finance.bank_transactions (bank_account_id, fingerprint)');
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
      await withoutForcedRls(q, async () => {
        await q('DROP INDEX IF EXISTS finance.bank_transactions_account_fingerprint_uk');
        const [rows] = await q(`SELECT DISTINCT ON (a.entity_id) a.entity_id AS id, a.group_id, a.company_id, a.before_json->>'fingerprint' AS original, a.after_json->>'fingerprint' AS atual
                                  FROM audit.audit_log a WHERE a.action = :action ORDER BY a.entity_id, a.occurred_at DESC`, { action: ACTION_ROW });
        await withoutUpdateTriggers(q, async () => {
          for (const r of rows) {
            const [, meta] = await q('UPDATE finance.bank_transactions SET fingerprint = :original WHERE id = :id AND fingerprint = :atual', { original: r.original, id: r.id, atual: r.atual });
            if (meta && meta.rowCount === 0) continue;
            await q(AUDIT, {
              g: r.group_id, c: r.company_id, action: `${ACTION_ROW}_reverted`, tipo: 'BankTransaction', id: r.id,
              b: JSON.stringify({ fingerprint: r.atual }), a: JSON.stringify({ fingerprint: r.original }),
              r: 'Migration 20260101010411 (down): fingerprint original devolvido; índice volta a ser parcial.',
            });
          }
        });
        await q(`CREATE UNIQUE INDEX bank_transactions_account_fingerprint_uk
                   ON finance.bank_transactions (bank_account_id, fingerprint) WHERE external_transaction_id IS NOT NULL`);
      });
    });
  },
};
