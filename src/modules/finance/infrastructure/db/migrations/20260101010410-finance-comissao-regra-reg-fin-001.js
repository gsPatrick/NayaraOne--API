'use strict';

/**
 * DEC-005 (Maturacao/demandas/decisoes.md) e Guia M4 §11 — a comissão usa a regra REG-FIN-001 do Motor de Regras (`rules.evaluate('REG-FIN-001', ...)`);
 * REG-FIN-002 é o limite de aprovação de pagamento (Guia §4). Até aqui o código gravava a regra de comissão como REG-FIN-002.
 *
 * Migração de DADOS: cada core.rules de comissão gravada como REG-FIN-002 passa a REG-FIN-001 (UPDATE só do código; ids das regras e das versões,
 * números de versão, percentuais e o vínculo commissions.rule_version_id ficam intactos — nada é apagado nem recriado). Regra de comissão =
 * REG-FIN-002 cujas versões têm o formato da comissão (action_json com `components` e base SOURCE_ENTRY_AMOUNT) ou, sem versão, o nome da regra de
 * comissão. Uma REG-FIN-002 de outro formato (limite de aprovação) não é tocada.
 *
 * Auditoria antes/depois: uma linha em audit.audit_log por regra movida (`finance.commission_rule.code_migrated`, versões e comissões ligadas antes e
 * depois) e a conferência das contagens (a migração aborta se alguma versão ou comissão mudar de regra). Empresa que já tenha uma REG-FIN-001 própria
 * não é mesclada às cegas: a migração para com a lista (decisão humana). Ida e volta: o `down` devolve ao código antigo exatamente as regras
 * registradas pela ida (pela trilha), também auditado.
 */
const RULE_NAME = 'Percentual de comissão por componente (fato gerador: recebimento)';
const AUDIT = `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
  VALUES (gen_random_uuid(), :g, :c, NULL, :action, 'Rule', :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`;
const TABLES = ['core.rules', 'core.rule_versions', 'finance.commissions', 'audit.audit_log'];

/** FORCE RLS vale até para o dono: tira durante a migração (padrão das migrations de carga) e devolve ao estado exato de antes. */
async function withoutForcedRls(q, fn) {
  const [rows] = await q(`SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                           WHERE c.relforcerowsecurity AND (n.nspname || '.' || c.relname) IN (:t)`, { t: TABLES });
  const forced = rows.map((r) => r.t);
  for (const t of forced) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
  try { return await fn(); } finally { for (const t of forced) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`); }
}

/** Retrato de uma regra: versões (id, número) e quantas comissões apontam para elas. */
async function snapshot(q, ruleId) {
  const [rule] = await q('SELECT id, group_id, company_id, code, name FROM core.rules WHERE id = :id', { id: ruleId });
  const [versions] = await q('SELECT id, version_number AS "versionNumber" FROM core.rule_versions WHERE rule_id = :id ORDER BY version_number', { id: ruleId });
  const [[{ n }]] = await q('SELECT count(*)::int AS n FROM finance.commissions WHERE rule_version_id IN (SELECT id FROM core.rule_versions WHERE rule_id = :id)', { id: ruleId });
  return { code: rule[0].code, versions, commissions: n };
}

const sameShape = (a, b) => JSON.stringify({ v: a.versions, c: a.commissions }) === JSON.stringify({ v: b.versions, c: b.commissions });

async function commissionRulesWithCode(q, code) {
  const [rows] = await q(
    `SELECT r.id, r.group_id, r.company_id FROM core.rules r
      WHERE r.code = :code
        AND ( (EXISTS (SELECT 1 FROM core.rule_versions v WHERE v.rule_id = r.id)
               AND NOT EXISTS (SELECT 1 FROM core.rule_versions v WHERE v.rule_id = r.id
                                AND NOT (v.action_json ? 'components' AND v.action_json->>'base' = 'SOURCE_ENTRY_AMOUNT')))
           OR (NOT EXISTS (SELECT 1 FROM core.rule_versions v WHERE v.rule_id = r.id) AND r.name = :name) )
      ORDER BY r.created_at`, { code, name: RULE_NAME });
  return rows;
}

async function move(q, rules, { from, to, action, reason }) {
  for (const r of rules) {
    const before = await snapshot(q, r.id);
    await q('UPDATE core.rules SET code = :to, updated_at = now() WHERE id = :id AND code = :from', { id: r.id, to, from });
    const after = await snapshot(q, r.id);
    if (after.code !== to || !sameShape(before, after)) throw new Error(`[${action}] regra ${r.id}: retrato depois não confere com o de antes.`);
    await q(AUDIT, { g: r.group_id, c: r.company_id, action, id: r.id, b: JSON.stringify(before), a: JSON.stringify(after), r: reason });
  }
}

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
      await withoutForcedRls(q, async () => {
        const rules = await commissionRulesWithCode(q, 'REG-FIN-002');
        if (!rules.length) return;
        const [conflicts] = await q(
          `SELECT DISTINCT o.company_id FROM core.rules o JOIN core.rules r ON r.group_id = o.group_id AND r.company_id = o.company_id
            WHERE o.code = 'REG-FIN-001' AND r.id IN (:ids)`, { ids: rules.map((r) => r.id) });
        if (conflicts.length) {
          throw new Error(`DEC-005: empresa(s) ${conflicts.map((c) => c.company_id).join(', ')} já têm REG-FIN-001 além da comissão em REG-FIN-002; resolver antes (sem mescla automática).`);
        }
        const [[{ v: versionsBefore }]] = await q('SELECT count(*)::int AS v FROM core.rule_versions WHERE rule_id IN (:ids)', { ids: rules.map((r) => r.id) });
        await move(q, rules, { from: 'REG-FIN-002', to: 'REG-FIN-001', action: 'finance.commission_rule.code_migrated', reason: 'Migration 20260101010410 (DEC-005, Guia M4 §11): regra de comissão passa de REG-FIN-002 para REG-FIN-001; versões e comissões intactas.' });
        const [[{ v: versionsAfter }]] = await q("SELECT count(*)::int AS v FROM core.rule_versions v JOIN core.rules r ON r.id = v.rule_id WHERE r.id IN (:ids) AND r.code = 'REG-FIN-001'", { ids: rules.map((r) => r.id) });
        if (versionsBefore !== versionsAfter) throw new Error(`DEC-005: ${versionsBefore} versões antes e ${versionsAfter} depois.`);
        const restantes = await commissionRulesWithCode(q, 'REG-FIN-002');
        if (restantes.length) throw new Error(`DEC-005: ${restantes.length} regra(s) de comissão ainda em REG-FIN-002.`);
      });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => queryInterface.sequelize.query(sql, { replacements, transaction });
      await withoutForcedRls(q, async () => {
        // Só as regras que a ida moveu (trilha) e que ainda não voltaram.
        const [rules] = await q(
          `SELECT DISTINCT r.id, r.group_id, r.company_id FROM audit.audit_log a JOIN core.rules r ON r.id = a.entity_id AND r.code = 'REG-FIN-001'
            WHERE a.action = 'finance.commission_rule.code_migrated'`);
        await move(q, rules, { from: 'REG-FIN-001', to: 'REG-FIN-002', action: 'finance.commission_rule.code_migration_reverted', reason: 'Migration 20260101010410 (down): regra de comissão volta ao código antigo REG-FIN-002.' });
      });
    });
  },
};
