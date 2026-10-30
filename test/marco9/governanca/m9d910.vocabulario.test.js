'use strict';

// M9-D910 §3.2.5 — o vocabulário antigo (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) converte para LOW, MEDIUM, HIGH e RESTRICTED sem perda e de forma reversível; os modelos validam a escala nova.
// Banco descartável: ver m9d910.registro.test.js.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Sequelize } = require('sequelize');
const env = require('../_helpers/m9d910Env');
const migration = require('../../../migrations/20260101000858-convert-legacy-classification-vocabulary');
const scale = require('../../../src/shared/data-classification/scale');
const { PropertyMedia, KnowledgeEntry, CaseDocument } = require('../../../src/models');

let admin;
const adminSequelize = () => { if (!admin) admin = new Sequelize(process.env.DATABASE_ADMIN_URL, { logging: false }); return admin; };
after(async () => { if (admin) await admin.close(); await env.sequelize.close(); });

test('m9d910 o mapeamento é reversível: PUBLIC, INTERNAL, CONFIDENTIAL e RESTRICTED viram LOW, MEDIUM, HIGH e RESTRICTED e voltam; desconhecido vira HIGH', () => {
  const pairs = [['PUBLIC', 'LOW'], ['INTERNAL', 'MEDIUM'], ['CONFIDENTIAL', 'HIGH'], ['RESTRICTED', 'RESTRICTED']];
  for (const [legacy, now] of pairs) { assert.equal(scale.normalize(legacy), now); assert.equal(scale.toLegacy(now), legacy); assert.equal(scale.normalize(now), now); }
  assert.deepEqual([scale.normalize('SECRETO'), scale.normalize(null), scale.normalize(' internal ')], ['HIGH', null, 'MEDIUM']);
  assert.equal(scale.highest(['LOW', 'RESTRICTED', 'MEDIUM']), 'RESTRICTED');
});

test('m9d910 as três tabelas aceitam só a escala nova no banco e guardam o valor antigo em legacy_classification', { skip: env.skip() }, async () => {
  for (const t of migration.TABLES) {
    const [schema, table] = t.ref.split('.');
    const col = await env.adminQuery("SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'legacy_classification'", [schema, table]);
    assert.equal(col.rowCount, 1, `${t.ref}.legacy_classification`);
    const def = (await env.adminQuery('SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2', [t.ref, t.constraint])).rows[0].d;
    assert.match(def, /LOW/); assert.match(def, /MEDIUM/); assert.doesNotMatch(def, /CONFIDENTIAL|INTERNAL|PUBLIC/, t.ref);
  }
  const outbox = await env.adminQuery("SELECT 1 FROM information_schema.columns WHERE table_schema = 'integration' AND table_name = 'outbox_events' AND column_name = 'legacy_classification'");
  assert.equal(outbox.rowCount, 0, 'a classificação de falha (TRANSIENT, VALIDATION, CONFLICT) fica fora do mapeamento');
});

test('m9d910 valores legados PUBLIC, INTERNAL e RESTRICTED convertem para LOW, MEDIUM e RESTRICTED sem perda (migration real: volta ao antigo, grava legado, converte e reverte)', { skip: env.skip() }, async () => {
  const sequelize = adminSequelize();
  const qi = sequelize.getQueryInterface();
  const tenant = (await env.loadTenants()).A;
  const ids = {};
  await migration.down(qi); // volta ao vocabulário antigo para gravar dado legado de verdade
  try {
    for (const legacy of ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']) {
      ids[legacy] = randomUUID();
      await env.adminQuery(`INSERT INTO ai.knowledge_entries (id, group_id, company_id, subject_type, fact_key, fact_value_json, classification, version, title, content_hash)
        VALUES ($1, $2, $3, 'politica', $4, '{"a":1}'::jsonb, $5, 1, 'QA-M9 D910', repeat('b', 64))`, [ids[legacy], tenant.groupId, tenant.companyId, `qa-m9d910-${legacy}-${ids[legacy]}`, legacy]);
    }
    await migration.up(qi);
    const read = async () => Object.fromEntries((await env.adminQuery('SELECT id, classification, legacy_classification FROM ai.knowledge_entries WHERE id = ANY($1)', [Object.values(ids)])).rows.map((r) => [r.id, [r.legacy_classification, r.classification]]));
    const converted = await read();
    assert.deepEqual(Object.entries(ids).map(([, id]) => converted[id]), [['PUBLIC', 'LOW'], ['INTERNAL', 'MEDIUM'], ['CONFIDENTIAL', 'HIGH'], ['RESTRICTED', 'RESTRICTED']], 'nenhum valor perdido e o antigo guardado');
    await migration.down(qi);
    const back = Object.fromEntries((await env.adminQuery('SELECT id, classification FROM ai.knowledge_entries WHERE id = ANY($1)', [Object.values(ids)])).rows.map((r) => [r.id, r.classification]));
    assert.deepEqual(Object.entries(ids).map(([, id]) => back[id]), ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'], 'reversível');
  } finally {
    await migration.up(qi).catch(() => {});
    await env.adminQuery('ALTER TABLE ai.knowledge_entries DISABLE TRIGGER USER');
    await env.adminQuery('DELETE FROM ai.knowledge_entries WHERE id = ANY($1)', [Object.values(ids)]);
    await env.adminQuery('ALTER TABLE ai.knowledge_entries ENABLE TRIGGER USER');
  }
  const final = await env.adminQuery("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'ai.knowledge_entries'::regclass AND conname = 'knowledge_classification_chk'");
  assert.match(final.rows[0].d, /LOW/, 'o banco termina na escala nova');
});

test('m9d910 os modelos validam a escala nova: gravam LOW/MEDIUM/HIGH/RESTRICTED, aceitam o valor antigo na entrada e desconhecido vira HIGH', () => {
  const media = PropertyMedia.build({ classification: 'PUBLIC' });
  assert.equal(media.getDataValue('classification'), 'LOW');
  assert.equal(media.classification, 'LOW', 'a mídia do portal agora é LOW');
  assert.equal(PropertyMedia.build({ classification: 'SECRETO' }).getDataValue('classification'), 'HIGH');
  const doc = CaseDocument.build({ classification: 'INTERNAL' });
  assert.equal(doc.getDataValue('classification'), 'MEDIUM');
  assert.equal(CaseDocument.build({}).classification, 'RESTRICTED', 'o padrão de documento de caso continua RESTRICTED');
  const entry = KnowledgeEntry.build({ classification: 'CONFIDENTIAL' });
  assert.equal(entry.getDataValue('classification'), 'HIGH', 'o banco recebe a escala nova');
  assert.equal(entry.classification, 'CONFIDENTIAL', 'o módulo de IA ainda lê o vocabulário antigo');
  assert.equal(KnowledgeEntry.build({}).getDataValue('classification'), 'MEDIUM', 'o padrão INTERNAL virou MEDIUM');
  for (const Model of [PropertyMedia, CaseDocument, KnowledgeEntry]) assert.ok(Model.rawAttributes.classification.validate.isIn.args[0].includes('RESTRICTED'));
});
