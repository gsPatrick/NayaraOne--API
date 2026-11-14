'use strict';

const { forceRestaurado } = require('../src/shared/db/forceRestaurado');
/**
 * DI-M3CA-2 e DI-M3CA-3 (livro do Marco 3 §10 e §3; matriz CAD-10 e M3-12).
 *  1. Estágios terminais gravados com o código do livro: CLOSED_WON -> WON, CLOSED_LOST -> LOST e WITHDRAWN -> LOST (a desistência
 *     é perda com motivo de desistência: lost_reason recebe o withdrawn_reason quando vazio; withdrawn_reason fica como estava e marca
 *     a categoria). Cada linha convertida deixa no audit_log (`opportunity.stage_migrated`) o antes e o depois.
 *  2. Gatilho `crm.opportunities_stage_do_livro`: quem ainda gravar CLOSED_WON/CLOSED_LOST (código antigo) grava WON/LOST.
 *  3. crm.loss_reasons passa a ser a visão dos motivos CONFIGURADOS de cada empresa (crm.motivos.ganho / .perda / .desistencia em
 *     core.tenant_settings, com os padrões do código quando a empresa não configurou), no lugar dos VALUES fixos da 20260101009974.
 *  4. O parâmetro do BI `analytics.comercial.ordem_estagios` que citar CLOSED_WON/CLOSED_LOST passa a citar WON/LOST.
 * O down desfaz tudo: volta os códigos antigos (WITHDRAWN e o motivo anterior pelo audit_log desta migration), apaga o gatilho,
 * recria a visão antiga e o parâmetro antigo. Os registros de auditoria ficam (histórico).
 */
const MIGRATION = '20261111031001';
const DEFAULTS = {
  'crm.motivos.ganho': ['WON', 'WON', 'PRICE_ACCEPTED=Preço aceito,FAST_DECISION=Decisão rápida,REFERRAL=Indicação,OTHER=Outro motivo'],
  'crm.motivos.perda': ['LOST', 'LOSS', 'PRICE_TOO_HIGH=Preço alto,COMPETITOR=Concorrente,FINANCING_DENIED=Financiamento negado,LOCATION=Localização,OTHER=Outro motivo'],
  'crm.motivos.desistencia': ['LOST', 'WITHDRAWAL', 'CLIENT_GAVE_UP=Cliente desistiu,NO_RESPONSE=Sem resposta,CHANGED_MIND=Mudou de ideia'],
};
const OLD_LOSS_REASONS = require('./20260101009974-m3-livro-entidades-com-o-nome-do-livro').LOSS_REASONS;
const lit = (text) => `'${String(text).replace(/'/g, "''")}'`;
const TABLES = ['crm.opportunities', 'audit.audit_log', 'core.tenant_settings'];

/** Tira o FORCE RLS só das tabelas que o têm, durante a conversão, e devolve no fim (mesmo padrão da 20260101009975). */
async function withoutForcedRls(sequelize, transaction, fn) {
  const [rows] = await sequelize.query(
    `SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relforcerowsecurity AND n.nspname || '.' || c.relname IN (${TABLES.map(lit).join(', ')})`,
    { transaction }
  );
  const forced = rows.map((r) => r.t);
  for (const t of forced) await sequelize.query(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`, { transaction });
  return await forceRestaurado(async () => {
    return await fn();
  }, async () => {
    for (const t of forced) await sequelize.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`, { transaction });
  });
}

async function audit(q, row, before, after, reason) {
  await q(
    `INSERT INTO audit.audit_log (id, group_id, company_id, user_id, action, entity_type, entity_id, before_json, after_json, reason, occurred_at, created_at, updated_at)
     VALUES (gen_random_uuid(), :g, :c, NULL, :action, :type, :id, :b::jsonb, :a::jsonb, :r, now(), now(), now())`,
    { g: row.group_id, c: row.company_id, id: row.id, action: row.action || 'opportunity.stage_migrated', type: row.type || 'Opportunity', b: JSON.stringify(before), a: JSON.stringify(after), r: reason }
  );
}

const viewSql = () => {
  const keys = Object.entries(DEFAULTS).map(([key, [stage, category, padrao]]) => `(${lit(key)}, ${lit(stage)}, ${lit(category)}, ${lit(padrao)})`).join(', ');
  return `CREATE VIEW crm.loss_reasons WITH (security_invoker = true) AS
    SELECT c.id AS company_id, k.outcome_stage, k.category, btrim(split_part(t.item, '=', 1)) AS code, btrim(split_part(t.item, '=', 2)) AS label, t.ord::int AS sort_order
      FROM core.companies c
      CROSS JOIN (VALUES ${keys}) AS k(setting_key, outcome_stage, category, padrao)
      CROSS JOIN LATERAL unnest(string_to_array(COALESCE(
        (SELECT ts.value #>> '{}' FROM core.tenant_settings ts WHERE ts.company_id = c.id AND ts.key = k.setting_key), k.padrao), ',')) WITH ORDINALITY AS t(item, ord)`;
};

const grantView = `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nayara_runtime') THEN GRANT SELECT ON crm.loss_reasons TO nayara_runtime; END IF; END $$`;

const TRIGGER = `
  CREATE OR REPLACE FUNCTION crm.opportunities_stage_do_livro() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    IF upper(btrim(NEW.stage)) = 'CLOSED_WON' THEN NEW.stage := 'WON';
    ELSIF upper(btrim(NEW.stage)) = 'CLOSED_LOST' THEN NEW.stage := 'LOST';
    END IF;
    -- Etapa final sem a data de fechamento recebe a da gravação, como a conversão das linhas antigas (COALESCE(closed_at, updated_at)):
    -- o BI do Marco 9 (rm_crm_outcome e rm_command_events) exige closed_at em toda oportunidade WON/LOST.
    IF NEW.stage IN ('WON', 'LOST') AND NEW.closed_at IS NULL THEN NEW.closed_at := COALESCE(NEW.updated_at, now()); END IF;
    RETURN NEW;
  END $fn$;
  DROP TRIGGER IF EXISTS opportunities_stage_do_livro ON crm.opportunities;
  CREATE TRIGGER opportunities_stage_do_livro BEFORE INSERT OR UPDATE OF stage ON crm.opportunities
    FOR EACH ROW EXECUTE FUNCTION crm.opportunities_stage_do_livro();`;

async function replaceStageOrderTokens(q, pairs) {
  const [rows] = await q("SELECT id, group_id, company_id, value #>> '{}' AS value FROM core.tenant_settings WHERE key = 'analytics.comercial.ordem_estagios'");
  for (const row of rows) {
    const next = String(row.value).split(',').map((p) => pairs[p.trim().toUpperCase()] || p.trim()).join(',');
    if (next === row.value) continue;
    await q("UPDATE core.tenant_settings SET value = to_jsonb(CAST(:v AS text)), updated_at = now() WHERE id = :id", { v: next, id: row.id });
    await audit(q, { ...row, action: 'governance.setting.migrated', type: 'TenantSetting' }, { key: 'analytics.comercial.ordem_estagios', value: row.value }, { value: next }, `Migration ${MIGRATION} (DI-M3CA-3): estágios do funil com o código do livro (WON/LOST).`);
  }
}

module.exports = {
  DEFAULTS,
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await withoutForcedRls(sequelize, transaction, async () => {
        const [linhas] = await q(
          `UPDATE crm.opportunities o
              SET stage = CASE WHEN v.antes = 'CLOSED_WON' THEN 'WON' ELSE 'LOST' END,
                  lost_reason = CASE WHEN v.antes = 'WITHDRAWN' THEN COALESCE(o.lost_reason, o.withdrawn_reason) ELSE o.lost_reason END,
                  closed_at = COALESCE(o.closed_at, o.updated_at), updated_at = now()
             FROM (SELECT id, upper(btrim(stage)) AS antes, lost_reason AS motivo_antes, closed_at AS fechada_antes FROM crm.opportunities
                    WHERE upper(btrim(stage)) IN ('CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN') FOR UPDATE) v
            WHERE o.id = v.id
            RETURNING o.id, o.group_id, o.company_id, o.stage, o.lost_reason, o.withdrawn_reason, o.closed_at, v.antes, v.motivo_antes, v.fechada_antes`
        );
        for (const l of linhas) {
          await audit(q, l, { stage: l.antes, lostReason: l.motivo_antes, closedAt: l.fechada_antes }, { stage: l.stage, lostReason: l.lost_reason, withdrawnReason: l.withdrawn_reason, closedAt: l.closed_at },
            `Migration ${MIGRATION} (DI-M3CA-3): estágio "${l.antes}" gravado com o código do livro do Marco 3 §10 (${l.stage}).`);
        }
        await replaceStageOrderTokens(q, { CLOSED_WON: 'WON', CLOSED_LOST: 'LOST' });
      });
      await q(TRIGGER);
      await q('DROP VIEW IF EXISTS crm.loss_reasons');
      await q(viewSql());
      await q(grantView);
    });
  },
  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (transaction) => {
      const q = (sql, replacements) => sequelize.query(sql, { transaction, replacements });
      await q('DROP TRIGGER IF EXISTS opportunities_stage_do_livro ON crm.opportunities');
      await q('DROP FUNCTION IF EXISTS crm.opportunities_stage_do_livro()');
      await withoutForcedRls(sequelize, transaction, async () => {
        // Linhas que eram WITHDRAWN voltam a WITHDRAWN com o motivo de perda anterior (o antes está no audit_log desta migration).
        await q(
          `UPDATE crm.opportunities o SET stage = 'WITHDRAWN', lost_reason = a.before_json->>'lostReason', updated_at = now()
             FROM audit.audit_log a
            WHERE a.action = 'opportunity.stage_migrated' AND a.entity_id = o.id AND a.before_json->>'stage' = 'WITHDRAWN'
              AND a.reason LIKE :marca AND o.stage = 'LOST'`,
          { marca: `Migration ${MIGRATION}%` }
        );
        await q("UPDATE crm.opportunities SET stage = 'CLOSED_WON', updated_at = now() WHERE stage = 'WON'");
        await q("UPDATE crm.opportunities SET stage = 'CLOSED_LOST', updated_at = now() WHERE stage = 'LOST'");
        await replaceStageOrderTokens(q, { WON: 'CLOSED_WON', LOST: 'CLOSED_LOST' });
      });
      await q('DROP VIEW IF EXISTS crm.loss_reasons');
      const values = OLD_LOSS_REASONS.map(([o, c, l]) => `(${lit(o)}, ${lit(c)}, ${lit(l)})`).join(', ');
      await q(`CREATE VIEW crm.loss_reasons AS SELECT outcome_stage, code, label FROM (VALUES ${values}) AS r(outcome_stage, code, label)`);
      await q(grantView);
    });
  },
};
