'use strict';

/**
 * BUG M45 (19/10/2026): dois contratos com "VEN-2026-0001" (SALE_CASH e SALE_TRADE).
 * Causa: a sequência era por (company, contract_type, ano), mas vários tipos compartilham o
 * mesmo prefixo (LEASE/LEASE_RESIDENTIAL -> LOC, SALE_* -> VEN). Cada tipo contava do 1.
 *
 * Correção:
 *  1. A sequência passa a ser por PREFIXO: a coluna contract_type de contract_number_sequences
 *     guarda o prefixo ('LOC','VEN',...). Linhas antigas por tipo ficam como histórico.
 *     O last_seq de cada prefixo começa no maior número já emitido (contratos ou sequências).
 *  2. Duplicados existentes: o contrato mais antigo (ou o não-rascunho) mantém o número; os
 *     demais — todos RASCUNHOS de teste (verificado em 19/10) — recebem o próximo número do
 *     prefixo. Nenhum contrato é apagado. Cada renumeração gera linha em audit.audit_log.
 *     Se algum duplicado não for rascunho, a migration ABORTA (não renumera contrato vivo).
 *  3. Índice único (company_id, contract_number) — garantia final no banco.
 */
const PREFIX = {
  LEASE: 'LOC', LEASE_RESIDENTIAL: 'LOC', LEASE_COMMERCIAL: 'LOC', LEASE_SEASONAL: 'LOC',
  PROPERTY_ADMIN: 'ADM',
  SALE: 'VEN', SALE_CASH: 'VEN', SALE_FINANCED: 'VEN', SALE_TRADE: 'VEN', SALE_INSTALLMENTS: 'VEN',
  SERVICE: 'SRV', CONSTRUCTION: 'OBR',
};

module.exports = {
  up: async (queryInterface) => {
    const s = queryInterface.sequelize;
    await s.transaction(async (transaction) => {
      const q = (sql, replacements) => s.query(sql, { replacements, transaction });
      await q('ALTER TABLE legal.contracts NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE legal.contract_number_sequences NO FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE audit.audit_log NO FORCE ROW LEVEL SECURITY');
      await q('LOCK TABLE legal.contract_number_sequences IN EXCLUSIVE MODE');
      await q('LOCK TABLE legal.contracts IN SHARE ROW EXCLUSIVE MODE');

      // 1) sequência por prefixo
      const [seqs] = await q('SELECT company_id, contract_type, "year", last_seq FROM legal.contract_number_sequences');
      const target = new Map();
      const bump = (company, prefix, year, n) => {
        const k = `${company}|${prefix}|${year}`;
        const cur = target.get(k);
        if (!cur || cur.n < n) target.set(k, { company, prefix, year, n });
      };
      for (const r of seqs) {
        const prefix = PREFIX[r.contract_type] || (Object.values(PREFIX).includes(r.contract_type) ? r.contract_type : null);
        if (prefix) bump(r.company_id, prefix, r.year, Number(r.last_seq));
      }
      const [nums] = await q(`SELECT company_id, contract_number FROM legal.contracts WHERE contract_number ~ '^[A-Z]{3}-[0-9]{4}-[0-9]+$'`);
      for (const r of nums) {
        const [p, y, n] = r.contract_number.split('-');
        bump(r.company_id, p, Number(y), Number(n));
      }
      for (const t of target.values()) {
        await q(`INSERT INTO legal.contract_number_sequences (id, company_id, contract_type, "year", last_seq, created_at, updated_at)
                 VALUES (gen_random_uuid(), :company, :prefix, :year, :n, now(), now())
                 ON CONFLICT (company_id, contract_type, "year") DO UPDATE SET last_seq = GREATEST(legal.contract_number_sequences.last_seq, EXCLUDED.last_seq), updated_at = now()`,
        { company: t.company, prefix: t.prefix, year: t.year, n: t.n });
      }

      // 2) duplicados
      const [dups] = await q(`
        SELECT id, group_id, company_id, contract_number, status, created_at,
               row_number() OVER (PARTITION BY company_id, contract_number
                                  ORDER BY (status <> 'DRAFT') DESC, created_at ASC, id) AS rn
        FROM legal.contracts
        WHERE contract_number IS NOT NULL
          AND (company_id, contract_number) IN (
            SELECT company_id, contract_number FROM legal.contracts WHERE contract_number IS NOT NULL
            GROUP BY 1, 2 HAVING count(*) > 1)
        ORDER BY company_id, contract_number, rn`);
      const toRenumber = dups.filter((d) => Number(d.rn) > 1);
      const live = toRenumber.filter((d) => d.status !== 'DRAFT');
      if (live.length) {
        throw new Error(`Duplicados não-rascunho encontrados (${live.map((d) => d.id).join(', ')}) — renumeração manual necessária.`);
      }
      for (const d of toRenumber) {
        const [p, y] = d.contract_number.split('-');
        const [[{ last_seq: n }]] = await q(`UPDATE legal.contract_number_sequences SET last_seq = last_seq + 1, updated_at = now()
                                         WHERE company_id = :c AND contract_type = :p AND "year" = :y RETURNING last_seq`,
        { c: d.company_id, p, y: Number(y) });
        const newNumber = `${p}-${y}-${String(n).padStart(4, '0')}`;
        await q('UPDATE legal.contracts SET contract_number = :nn, updated_at = now() WHERE id = :id', { nn: newNumber, id: d.id });
        await q(`INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
                 VALUES (gen_random_uuid(), :g, :c, NULL, 'CONTRACT_RENUMBERED', 'Contract', :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`,
        {
          g: d.group_id, c: d.company_id, id: d.id,
          b: JSON.stringify({ contractNumber: d.contract_number, status: d.status }),
          a: JSON.stringify({ contractNumber: newNumber, status: d.status }),
          r: 'Migration 20260101000530: número duplicado na empresa (sequência por tipo em vez de prefixo). Rascunho renumerado; o mais antigo manteve o número.',
        });
      }

      // 3) unicidade no banco
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS contracts_company_contract_number_unique
               ON legal.contracts (company_id, contract_number) WHERE contract_number IS NOT NULL`);

      await q('ALTER TABLE legal.contracts FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE legal.contract_number_sequences FORCE ROW LEVEL SECURITY');
      await q('ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY');
      const [[{ exists }]] = await q("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') AS exists");
      if (exists) {
        await q('GRANT SELECT, INSERT, UPDATE ON legal.contract_number_sequences TO nayara_runtime');
      }
    });
  },

  down: async (queryInterface) => {
    // Renumerações ficam (auditadas); só remove o índice.
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS legal.contracts_company_contract_number_unique');
  },
};
