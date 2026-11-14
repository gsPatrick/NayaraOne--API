'use strict';

const { forceRestaurado } = require('../../../../../shared/db/forceRestaurado');
/**
 * Caderno M4 §11 "Exato — ID externo/fingerprint + valor + data — Auto confirmado se fonte confiável" e FIN-009 "confirmação conforme risco"
 * (verificação do Marco 4, parte 1: uma linha digitada à mão era conciliada sozinha). A linha de extrato passa a guardar a ORIGEM e se ela é fonte
 * confiável, decididas pelo servidor na gravação (reconciliation-policy.js#sourceOf, DI-M4CC-2):
 *   source         MANUAL (digitada), FILE_IMPORT (arquivo), WEBHOOK / PROVIDER_FETCH (retorno assinado do provedor), LEGACY (gravada antes desta migration)
 *   source_trusted verdadeiro só para WEBHOOK/PROVIDER_FETCH e para arquivo importado por quem tem finance:reconcile
 * As linhas já gravadas não têm como provar a origem: ficam LEGACY e NÃO confiáveis (falha segura — continuam conciliáveis por uma pessoa, só não
 * confirmam sozinhas). Contagem antes/depois conferida e registrada na trilha (`finance.bank_transaction.source_backfill`, uma linha por empresa).
 * O `down` remove as colunas (o dado da origem das linhas novas some com elas — é o estado anterior) e registra a volta.
 */
const AUDIT = `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
  VALUES (gen_random_uuid(), :g, :c, NULL, :action, 'BankTransaction', NULL, :b::jsonb, :a::jsonb, :r, now(), now(), now())`;
const TABLES = ['finance.bank_transactions', 'audit.audit_log'];

async function withoutForcedRls(q, fn) {
  const [rows] = await q(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE c.relforcerowsecurity AND (n.nspname || '.' || c.relname) IN (:t)`, { t: TABLES });
  const forced = rows.map((r) => r.t);
  for (const t of forced) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
  return await forceRestaurado(async () => { return await fn(); }, async () => { for (const t of forced) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); });
}

const perCompany = (q) => q('SELECT group_id, company_id, count(*)::int AS n FROM finance.bank_transactions GROUP BY group_id, company_id ORDER BY company_id');

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
      await withoutForcedRls(q, async () => {
        const [antes] = await perCompany(q);
        // ADD COLUMN com DEFAULT preenche as linhas existentes sem UPDATE (nenhum gatilho de UPDATE dispara): LEGACY, não confiável.
        await q("ALTER TABLE finance.bank_transactions ADD COLUMN source varchar(32) NOT NULL DEFAULT 'LEGACY'");
        await q('ALTER TABLE finance.bank_transactions ADD COLUMN source_trusted boolean NOT NULL DEFAULT false');
        // Linha nova sem origem informada é MANUAL (a mais restritiva entre as reais).
        await q("ALTER TABLE finance.bank_transactions ALTER COLUMN source SET DEFAULT 'MANUAL'");
        await q(`ALTER TABLE finance.bank_transactions ADD CONSTRAINT bank_transactions_source_ck
                   CHECK (source IN ('MANUAL', 'FILE_IMPORT', 'WEBHOOK', 'PROVIDER_FETCH', 'LEGACY'))`);
        // Digitada à mão ou legada nunca é confiável, qualquer que seja o caminho de gravação.
        await q(`ALTER TABLE finance.bank_transactions ADD CONSTRAINT bank_transactions_source_trusted_ck
                   CHECK (NOT source_trusted OR source IN ('FILE_IMPORT', 'WEBHOOK', 'PROVIDER_FETCH'))`);
        const [depois] = await perCompany(q);
        if (JSON.stringify(antes) !== JSON.stringify(depois)) throw new Error('origem do extrato: contagem por empresa mudou — abortado.');
        const [[{ errados }]] = await q("SELECT count(*)::int AS errados FROM finance.bank_transactions WHERE source <> 'LEGACY' OR source_trusted");
        if (errados !== 0) throw new Error(`origem do extrato: ${errados} linha(s) existentes fora de LEGACY/não confiável — abortado.`);
        for (const c of depois) {
          await q(AUDIT, {
            g: c.group_id, c: c.company_id, action: 'finance.bank_transaction.source_backfill',
            b: JSON.stringify({ linhas: c.n, source: null }), a: JSON.stringify({ linhas: c.n, source: 'LEGACY', sourceTrusted: false }),
            r: 'Migration 20260101010412 (Caderno §11 fonte confiável): linhas de extrato anteriores sem origem comprovada ficam LEGACY e não confirmam sozinhas.',
          });
        }
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
      await withoutForcedRls(q, async () => {
        const [porOrigem] = await q('SELECT group_id, company_id, source, source_trusted, count(*)::int AS n FROM finance.bank_transactions GROUP BY 1, 2, 3, 4 ORDER BY 2, 3');
        await q('ALTER TABLE finance.bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_source_trusted_ck');
        await q('ALTER TABLE finance.bank_transactions DROP CONSTRAINT IF EXISTS bank_transactions_source_ck');
        await q('ALTER TABLE finance.bank_transactions DROP COLUMN IF EXISTS source_trusted');
        await q('ALTER TABLE finance.bank_transactions DROP COLUMN IF EXISTS source');
        const empresas = new Map();
        for (const r of porOrigem) {
          const e = empresas.get(r.company_id) || { g: r.group_id, origens: [] };
          e.origens.push({ source: r.source, sourceTrusted: r.source_trusted, linhas: r.n });
          empresas.set(r.company_id, e);
        }
        for (const [companyId, e] of empresas) {
          await q(AUDIT, {
            g: e.g, c: companyId, action: 'finance.bank_transaction.source_backfill_reverted',
            b: JSON.stringify({ origens: e.origens }), a: JSON.stringify({ source: null }),
            r: 'Migration 20260101010412 (down): colunas de origem do extrato removidas.',
          });
        }
      });
    });
  },
};
