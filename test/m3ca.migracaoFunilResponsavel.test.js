'use strict';

/**
 * Migrations de dados das correções do Marco 3 (DI-M3CA-1 e DI-M3CA-3), ida e volta em banco descartável:
 *  - 20261111030001: CLOSED_WON/CLOSED_LOST/WITHDRAWN viram WON/LOST (desistência = LOST com o motivo), com antes/depois no audit_log;
 *  - 20261111030002: oportunidade sem responsável recebe responsável pela regra, com antes/depois e a regra no audit_log.
 * O down devolve exatamente o estado anterior (nada some). Usa DATABASE_ADMIN_URL para simular dado legado e rodar como o dono.
 */

const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize, getSeedTenant, withTenantTransaction } = require('./testHelpers');
const { createMember, createOutsider, createOpportunity } = require('./helpers/m3caCrm');

const FILES = ['20261111030001-m3-funil-won-lost-e-motivos-configuraveis.js', '20261111030002-m3-oportunidade-sem-responsavel-recebe-responsavel.js'];
let tenant;
let admin;
before(async () => {
  if (!process.env.DATABASE_ADMIN_URL || process.env.DISPOSABLE_DB !== '1') throw new Error('Rode em banco descartável (scripts/withDisposableDb.js).');
  tenant = await getSeedTenant();
  admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false });
});
after(async () => {
  await admin.close();
  await sequelize.close();
});

const rowsOf = async (ids) => {
  const [rows] = await admin.query('SELECT id, stage, lost_reason, withdrawn_reason, owner_user_id FROM crm.opportunities WHERE id IN (:ids)', { replacements: { ids } });
  return Object.fromEntries(rows.map((r) => [r.id, r]));
};

test('DI-M3CA-1/3: migrations de ida e volta — estágios do livro e responsável preenchido, com auditoria; o down devolve o legado', async () => {
  const caminhos = FILES.map((f) => path.join(__dirname, '..', 'migrations', f));
  for (const c of caminhos) assert.ok(fs.existsSync(c), `migration ${path.basename(c)} existe`);
  const [funil, responsavel] = caminhos.map((c) => require(c));

  const s = await withTenantTransaction(tenant, async (t) => {
    const criador = await createMember(tenant, t, { label: 'criador' });
    const fora = await createOutsider(t);
    const ops = [];
    for (let i = 0; i < 5; i += 1) ops.push((await createOpportunity(tenant, t, { ownerUserId: tenant.userId })).id);
    return { criador, fora, ops };
  });
  const [ganha, perdida, desistiu, semDonoCriador, semDonoFora] = s.ops;
  // Estado legado, como gravado antes da correção (gatilhos desligados só nesta sessão de administrador).
  await admin.transaction(async (t) => {
    await admin.query('SET LOCAL session_replication_role = replica', { transaction: t });
    const set = (id, sql, extra = {}) => admin.query(`UPDATE crm.opportunities SET ${sql} WHERE id = :id`, { replacements: { id, ...extra }, transaction: t });
    await set(ganha, "stage = 'CLOSED_WON', won_reason = 'REFERRAL', closed_at = now()");
    await set(perdida, "stage = 'CLOSED_LOST', lost_reason = 'COMPETITOR', closed_at = now()");
    await set(desistiu, "stage = 'WITHDRAWN', lost_reason = NULL, withdrawn_reason = 'CLIENT_GAVE_UP', closed_at = now()");
    await set(semDonoCriador, 'owner_user_id = NULL, created_by = :u, updated_by = :u', { u: s.criador });
    await set(semDonoFora, 'owner_user_id = NULL, created_by = :u, updated_by = :u', { u: s.fora });
  });

  await funil.up(admin.getQueryInterface());
  await responsavel.up(admin.getQueryInterface());
  let r = await rowsOf(s.ops);
  assert.equal(r[ganha].stage, 'WON');
  assert.equal(r[perdida].stage, 'LOST');
  assert.equal(r[desistiu].stage, 'LOST');
  assert.equal(r[desistiu].lost_reason, 'CLIENT_GAVE_UP', 'desistência vira perda com o motivo de desistência');
  assert.equal(r[desistiu].withdrawn_reason, 'CLIENT_GAVE_UP');
  assert.equal(r[semDonoCriador].owner_user_id, s.criador, 'quem criou (ativo na empresa) vira o responsável');
  assert.ok(r[semDonoFora].owner_user_id && r[semDonoFora].owner_user_id !== s.fora, 'usuário sem vínculo não vira responsável');
  const [aud] = await admin.query("SELECT entity_id, action, before_json, after_json FROM audit.audit_log WHERE entity_id IN (:ids) AND action IN ('opportunity.stage_migrated', 'opportunity.owner_backfilled')", { replacements: { ids: s.ops } });
  const de = (id, action) => aud.find((a) => a.entity_id === id && a.action === action);
  assert.deepEqual([de(desistiu, 'opportunity.stage_migrated').before_json.stage, de(desistiu, 'opportunity.stage_migrated').after_json.stage], ['WITHDRAWN', 'LOST']);
  assert.equal(de(ganha, 'opportunity.stage_migrated').before_json.stage, 'CLOSED_WON');
  assert.deepEqual([de(semDonoCriador, 'opportunity.owner_backfilled').before_json.ownerUserId, de(semDonoCriador, 'opportunity.owner_backfilled').after_json.rule], [null, 'CREATED_BY']);
  assert.equal(de(semDonoFora, 'opportunity.owner_backfilled').after_json.rule, 'OLDEST_MANAGER');
  const [[semDono]] = await admin.query('SELECT count(*)::int AS n FROM crm.opportunities WHERE owner_user_id IS NULL AND company_id = :c', { replacements: { c: tenant.companyId } });
  assert.equal(semDono.n, 0, 'nenhuma oportunidade da empresa fica sem responsável');

  // Volta: o legado reaparece exatamente como era.
  await responsavel.down(admin.getQueryInterface());
  await funil.down(admin.getQueryInterface());
  r = await rowsOf(s.ops);
  assert.deepEqual([r[ganha].stage, r[perdida].stage, r[desistiu].stage, r[desistiu].lost_reason], ['CLOSED_WON', 'CLOSED_LOST', 'WITHDRAWN', null]);
  assert.deepEqual([r[semDonoCriador].owner_user_id, r[semDonoFora].owner_user_id], [null, null]);
  const [[gatilho]] = await admin.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'opportunities_stage_do_livro'");
  assert.equal(gatilho.n, 0, 'o down apaga o gatilho');

  // Ida de novo: estado final do banco é o da correção.
  await funil.up(admin.getQueryInterface());
  await responsavel.up(admin.getQueryInterface());
  r = await rowsOf(s.ops);
  assert.deepEqual([r[ganha].stage, r[desistiu].stage, r[semDonoCriador].owner_user_id], ['WON', 'LOST', s.criador]);
  const [forcas] = await admin.query("SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE oid IN ('crm.opportunities'::regclass, 'audit.audit_log'::regclass)");
  assert.ok(forcas.every((x) => x.f === true), 'FORCE RLS restaurado');
  const [[visao]] = await admin.query("SELECT count(*)::int AS n FROM crm.loss_reasons WHERE company_id = :c AND category = 'WITHDRAWAL'", { replacements: { c: tenant.companyId } });
  assert.equal(visao.n, 3);
});
