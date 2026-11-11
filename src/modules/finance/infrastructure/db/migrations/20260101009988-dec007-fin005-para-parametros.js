'use strict';

/**
 * DEC-007 / DI-DEC007-2 — destino da regra FIN-005 do Motor de Regras ("Antifraude de pagamento ativo"). A DEC-007 manda "trocar a regra do Motor pelos
 * parâmetros da tela de Configurações": o código deixou de consultar o Motor e lê só os parâmetros (finance-settings.js). Esta migration leva para os
 * parâmetros o que a regra publicada fazia valer, para nenhuma empresa ficar com um limiar mais frouxo do que tinha, e aposenta a regra:
 *  1) para cada versão PUBLICADA da FIN-005: se o `action_json` trazia um número válido (na faixa do catálogo) MAIS RESTRITIVO que o padrão da DEC-007
 *     e a empresa não tinha valor gravado na tela, o código antigo aplicava esse número; ele é gravado em core.tenant_settings (auditoria
 *     finance.antifraud.fin005_value_migrated, antes/depois). Empresa com valor gravado na tela já usava o gravado: nada muda. Número mais frouxo que o
 *     padrão não valia (o código antigo apertava): não é levado.
 *  2) a versão vira RETIRED com effective_until = agora (auditoria rules.version_retired, antes/depois). O histórico da regra fica.
 * Idempotente (só versões PUBLISHED; parâmetro já gravado não é tocado). Empresa nova não depende de script: sem nada gravado vale o padrão da DEC-007.
 * As faixas e padrões abaixo são o retrato do catálogo (parametros.csv) nesta data; um teste confere que acompanham o código.
 */
const MAPA = [
  { action: 'historyMultiplier', key: 'finance.antifraud_history_multiplier', padrao: 3, min: 1, max: 100, inteiro: false, maisRestritivo: (a, p) => a < p },
  { action: 'newAccountThreshold', key: 'finance.antifraud_new_account_threshold', padrao: 5000, min: 0, max: 999999999.99, inteiro: false, maisRestritivo: (a, p) => a < p },
  { action: 'bankAccountCooldownHours', key: 'finance.bank_account_cooldown_hours', padrao: 48, min: 0, max: 720, inteiro: true, maisRestritivo: (a, p) => a > p },
];

const AUDITORIA = `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
  VALUES (gen_random_uuid(), :g, :c, NULL, :action, :tipo, :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`;

const valido = (m, v) => typeof v === 'number' && Number.isFinite(v) && v >= m.min && v <= m.max && (!m.inteiro || Number.isInteger(v));

/** `q(sql, replacements)` roda dentro de uma transação já aberta (migration e teste). Devolve o que foi levado e aposentado. */
async function migrar(q) {
  const [versoes] = await q(
    `SELECT v.id, v.group_id, v.company_id, v.status, v.effective_until, v.action_json
       FROM core.rule_versions v JOIN core.rules r ON r.id = v.rule_id
      WHERE r.code = 'FIN-005' AND v.status = 'PUBLISHED'
      ORDER BY v.company_id, v.created_at`, {});
  const levados = [];
  for (const v of versoes) {
    const acao = v.action_json || {};
    for (const m of MAPA) {
      const a = acao[m.action];
      if (!valido(m, a) || !m.maisRestritivo(a, m.padrao)) continue;
      const [ja] = await q('SELECT id FROM core.tenant_settings WHERE company_id = :c AND key = :key AND deleted_at IS NULL', { c: v.company_id, key: m.key });
      if (ja.length) continue;
      const [[linha]] = await q(
        `INSERT INTO core.tenant_settings (id, group_id, company_id, key, value, created_by, updated_by, created_at, updated_at)
         VALUES (gen_random_uuid(), :g, :c, :key, to_jsonb(CAST(:valor AS numeric)), NULL, NULL, now(), now())
         ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, deleted_at = NULL, deleted_by = NULL, updated_by = NULL, updated_at = now()
         RETURNING id`, { g: v.group_id, c: v.company_id, key: m.key, valor: a });
      await q(AUDITORIA, {
        g: v.group_id, c: v.company_id, action: 'finance.antifraud.fin005_value_migrated', tipo: 'TenantSetting', id: linha.id,
        b: JSON.stringify({ key: m.key, value: null, efetivoAntes: a, origem: `regra FIN-005 versão ${v.id}` }), a: JSON.stringify({ key: m.key, value: a }),
        r: `Migration 20260101009988 (DEC-007, DI-DEC007-2): o valor ${a} da regra FIN-005 do Motor, mais restritivo que o padrão ${m.padrao}, passa a ser o parâmetro da tela de Configurações.`,
      });
      levados.push({ companyId: v.company_id, key: m.key, value: a });
    }
    await q("UPDATE core.rule_versions SET status = 'RETIRED', effective_until = now(), updated_at = now() WHERE id = :id", { id: v.id });
    await q(AUDITORIA, {
      g: v.group_id, c: v.company_id, action: 'rules.version_retired', tipo: 'RuleVersion', id: v.id,
      b: JSON.stringify({ code: 'FIN-005', status: v.status, effectiveUntil: v.effective_until, actionJson: acao }), a: JSON.stringify({ code: 'FIN-005', status: 'RETIRED' }),
      r: 'Migration 20260101009988 (DEC-007, DI-DEC007-2): os limiares do antifraude são os parâmetros da tela de Configurações; a regra FIN-005 do Motor deixou de ser consultada.',
    });
  }
  return { aposentadas: versoes.length, levados };
}

const TABELAS = ['core.rules', 'core.rule_versions', 'core.tenant_settings', 'audit.audit_log'];

module.exports = {
  up: async (queryInterface) => {
    const s = queryInterface.sequelize;
    await s.transaction(async (transaction) => {
      const q = (sql, replacements) => s.query(sql, { replacements, transaction });
      for (const t of TABELAS) await q(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
      await migrar(q);
      for (const t of TABELAS) await q(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    });
  },
  down: async () => {}, // não se desfaz: o valor anterior e a versão aposentada estão na auditoria
  migrar, MAPA,
};
