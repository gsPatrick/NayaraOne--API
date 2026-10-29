'use strict';

// M9-D409 — o mesmo evento entregue ao mesmo tempo por várias conexões (COMMIT real) gera UM rascunho; o índice único do banco é a
// garantia final. Só em banco descartável (DISPOSABLE_DB=1 e DATABASE_ADMIN_URL): node scripts/withDisposableDb.js ...

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { sequelize } = require('../../../src/models');
const { withTenantTransaction } = require('../../testHelpers');
const { prepararTenants } = require('../../helpers/marketingExecucao');
const env = require('../_helpers/mktTipos');
const { HANDLERS } = require('../../../src/features/marketing/content/types/triggers.consumers');

const DISPOSABLE = process.env.DISPOSABLE_DB === '1' && Boolean(process.env.DATABASE_ADMIN_URL);
const SKIP = !DISPOSABLE && 'precisa do banco descartável (as transações concorrentes COMMITAM)';
let tenant;
before(async () => { ({ tenantA: tenant } = await prepararTenants()); });
after(async () => { await sequelize.close(); });

async function adminRun(sql, params) {
  const admin = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await admin.connect();
  try { return await admin.query(sql, params); } finally { await admin.end(); }
}

test('o_mesmo_evento_entregue_em_paralelo_gera_um_unico_rascunho', { skip: SKIP }, async () => {
  const tx = (fn) => withTenantTransaction(tenant, fn);
  const prop = await tx((t) => env.activeProperty(t, tenant));
  const event = env.outboxEvent(tenant, 'property.published', prop.propertyId, { id: prop.propertyId });
  try {
    const results = await Promise.all([1, 2, 3, 4].map(() => tx((t) => HANDLERS['property.published'](event, t))));
    assert.equal(results.filter((r) => r.created).length, 1, 'exatamente uma entrega cria');
    assert.equal(new Set(results.map((r) => r.itemId)).size, 1, 'todas apontam para o mesmo rascunho');
    const rows = (await adminRun("SELECT id FROM marketing.content_items WHERE source_entity_id = $1 AND type = 'NEW_PROPERTY'", [prop.propertyId])).rows;
    assert.equal(rows.length, 1);

    // garantia final no banco: inserir a mesma chave (empresa, tipo, fonte, evento) por fora do código é recusado
    await assert.rejects(
      adminRun(`INSERT INTO marketing.content_items (group_id, company_id, type, title, source_entity_type, source_entity_id, trigger_event_id)
        VALUES ($1, $2, 'NEW_PROPERTY', 'QA-M9 duplicado', 'property', $3, $4)`, [tenant.groupId, tenant.companyId, prop.propertyId, event.id]),
      (e) => e.code === '23505' && /mkt_content_items_trigger_uq/.test(e.constraint || e.message)
    );
    // outro tipo com a mesma fonte e o mesmo evento é permitido (a chave inclui o tipo)
    await adminRun(`INSERT INTO marketing.content_items (group_id, company_id, type, title, source_entity_type, source_entity_id, trigger_event_id)
      VALUES ($1, $2, 'SOLD_RENTED', 'QA-M9 outro tipo', 'property', $3, $4)`, [tenant.groupId, tenant.companyId, prop.propertyId, event.id]);
  } finally {
    await adminRun('UPDATE marketing.content_items SET current_version_id = NULL WHERE source_entity_id = $1', [prop.propertyId]);
    await adminRun('DELETE FROM marketing.content_versions WHERE content_item_id IN (SELECT id FROM marketing.content_items WHERE source_entity_id = $1)', [prop.propertyId]);
    await adminRun('DELETE FROM marketing.content_items WHERE source_entity_id = $1', [prop.propertyId]);
  }
});
