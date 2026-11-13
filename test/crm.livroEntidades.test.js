'use strict';

/**
 * Livro do Marco 3 §3 "Entidades obrigatórias": toda entidade listada existe com o nome do livro (tabela ou visão sobre a
 * tabela de verdade), as visões respeitam o RLS de quem consulta (security_invoker) e o catálogo de motivos de perda bate
 * com o código que valida os desfechos.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, getSeedTenant, withRollbackTenantTransaction } = require('./testHelpers');
const { WON_REASONS, LOST_REASONS, WITHDRAWN_REASONS } = require('../src/features/crm/opportunityOutcomeReason.validator');

const ENTIDADES_DO_LIVRO = [
  'people.persons', 'people.person_roles', 'people.person_contacts', 'people.person_addresses', 'people.person_documents',
  'people.communication_consents', 'real_estate.properties', 'real_estate.property_owners', 'real_estate.property_offers',
  'real_estate.property_media', 'real_estate.property_documents', 'real_estate.property_price_history', 'crm.opportunities',
  'crm.interactions', 'crm.tasks', 'crm.visits', 'crm.proposals', 'crm.loss_reasons', 'crm.radars', 'crm.radar_matches',
  'crm.service_occurrences', 'crm.carts', 'real_estate.property_internal_occurrences',
];

let tenant;
before(async () => { tenant = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

test('§3: as 23 entidades do livro existem com o nome do livro (tabela ou visão)', async () => {
  const [rows] = await sequelize.query(
    "SELECT n.nspname || '.' || c.relname AS nome, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','v','p')"
  );
  const existentes = new Map(rows.map((r) => [r.nome, r.relkind]));
  const faltando = ENTIDADES_DO_LIVRO.filter((e) => !existentes.has(e));
  assert.deepEqual(faltando, [], `faltam: ${faltando.join(', ')}`);
});

test('§3: as visões com nome do livro usam security_invoker (valem o RLS e as permissões de quem consulta)', async () => {
  const [rows] = await sequelize.query(
    "SELECT n.nspname || '.' || c.relname AS nome, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v' AND n.nspname || '.' || c.relname IN ('crm.interactions','crm.tasks','crm.radars','crm.service_occurrences')"
  );
  assert.equal(rows.length, 4);
  for (const r of rows) assert.ok((r.reloptions || []).includes('security_invoker=true'), `${r.nome} sem security_invoker`);
});

test('§3: visão e tabela de origem devolvem as mesmas linhas para a mesma empresa (o RLS é o da tabela)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const par = [['crm.interactions', 'crm.messages'], ['crm.radars', 'crm.property_radars'], ['crm.service_occurrences', 'crm.feedback_cases'], ['crm.tasks', "core.tasks WHERE related_entity_type = 'crm.opportunities'"]];
    for (const [visao, origem] of par) {
      const [[a]] = await sequelize.query(`SELECT count(*)::int AS n FROM ${visao}`, { transaction });
      const [[b]] = await sequelize.query(`SELECT count(*)::int AS n FROM ${origem}`, { transaction });
      assert.equal(a.n, b.n, `${visao} x ${origem}`);
    }
    await sequelize.query("SET LOCAL app.company_id = '00000000-0000-4000-8000-000000000000'", { transaction });
    const [[nada]] = await sequelize.query('SELECT count(*)::int AS n FROM crm.interactions', { transaction });
    assert.equal(nada.n, 0, 'empresa inexistente não vê interação nenhuma pela visão');
  });
});

test('§3/M3-12: crm.loss_reasons é o catálogo de motivos que o código valida (padrões quando a empresa não configurou)', async () => {
  await withRollbackTenantTransaction(tenant, async (transaction) => {
    const [rows] = await sequelize.query('SELECT category, code FROM crm.loss_reasons WHERE company_id = :c ORDER BY category, sort_order', { replacements: { c: tenant.companyId }, transaction });
    const porCategoria = (c) => rows.filter((r) => r.category === c).map((r) => r.code).sort();
    assert.deepEqual(porCategoria('WON'), [...WON_REASONS].sort());
    assert.deepEqual(porCategoria('LOSS'), [...LOST_REASONS].sort());
    assert.deepEqual(porCategoria('WITHDRAWAL'), [...WITHDRAWN_REASONS].sort());
  });
});
