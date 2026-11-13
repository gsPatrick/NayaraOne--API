'use strict';

/**
 * DI-M3-FUNIL-1: a migration 20260101009975 converte etapas antigas (fora do funil do livro do Marco 3 §10) para a etapa
 * do livro e deixa antes/depois no audit_log. Roda SÓ em banco descartável (usa DATABASE_ADMIN_URL para simular dado legado
 * e executar a migration como o dono das tabelas). Rodar isolado, como os demais testes de migration.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Sequelize } = require('sequelize');
const { sequelize, getSeedTenant, withTenantTransaction, uniqueSuffix } = require('./testHelpers');
const personService = require('../src/features/people/person.service');
const opportunitiesService = require('../src/features/crm/opportunity.service');
const migration = require('../migrations/20260101009975-m3-funil-converte-etapas-antigas');

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

test('DI-M3-FUNIL-1: etapas antigas viram a etapa do livro, terminal ganha data de fechamento e cada conversão fica no audit_log', async () => {
  const ids = await withTenantTransaction(tenant, async (t) => {
    const person = await personService.createPerson({ groupId: tenant.groupId, companyId: tenant.companyId, personType: 'PF', legalName: `Legado funil ${uniqueSuffix()}` }, tenant.userId, t);
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      const o = await opportunitiesService.createOpportunity({ groupId: tenant.groupId, companyId: tenant.companyId, personId: person.id, stage: 'NEW', nextAction: 'Ligar', nextActionDueAt: new Date(Date.now() + 86400000).toISOString() }, tenant.userId, t);
      out.push(o.id);
    }
    return out;
  });
  const legado = ['NOVO', 'NEGOTIATION', 'PERDIDO', 'FASE_DESCONHECIDA'];
  for (let i = 0; i < ids.length; i += 1) {
    await admin.query('UPDATE crm.opportunities SET stage = :s, closed_at = NULL WHERE id = :id', { replacements: { s: legado[i], id: ids[i] } });
  }

  await migration.up(admin.getQueryInterface());

  const [linhas] = await admin.query('SELECT id, stage, closed_at FROM crm.opportunities WHERE id IN (:ids)', { replacements: { ids } });
  const por = Object.fromEntries(linhas.map((l) => [l.id, l]));
  assert.equal(por[ids[0]].stage, 'NEW');
  assert.equal(por[ids[1]].stage, 'PROPOSAL');
  // DI-M3CA-3: o código antigo do quadro (PERDIDO) vai direto para o código do livro (LOST).
  assert.equal(por[ids[2]].stage, 'LOST');
  assert.ok(por[ids[2]].closed_at, 'terminal convertido ganha data de fechamento');
  assert.equal(por[ids[3]].stage, 'FASE_DESCONHECIDA', 'valor fora do mapa não é tocado');
  const [aud] = await admin.query("SELECT entity_id, before_json, after_json FROM audit.audit_log WHERE action = 'opportunity.stage_migrated' AND entity_id IN (:ids)", { replacements: { ids } });
  assert.equal(aud.length, 3);
  const negociacao = aud.find((a) => a.entity_id === ids[1]);
  assert.equal(negociacao.before_json.stage, 'NEGOTIATION');
  assert.equal(negociacao.after_json.stage, 'PROPOSAL');
  const [[rls]] = await admin.query("SELECT relforcerowsecurity AS force FROM pg_class WHERE oid = 'crm.opportunities'::regclass");
  assert.equal(rls.force, true, 'FORCE RLS restaurado');

  await migration.up(admin.getQueryInterface());
  const [aud2] = await admin.query("SELECT count(*)::int AS n FROM audit.audit_log WHERE action = 'opportunity.stage_migrated' AND entity_id IN (:ids)", { replacements: { ids } });
  assert.equal(aud2[0].n, 3, 'rodar de novo não converte nem audita de novo');
});
