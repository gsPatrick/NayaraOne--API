'use strict';

// Apoio dos testes de Marketing que gravam conteúdo COMMITADO (HTTP real): remove o que o teste criou para não contaminar os testes de
// schema que contam linhas por empresa. Só em banco descartável (usa DATABASE_ADMIN_URL). Não é teste.
const { Client } = require('pg');

/** Apaga os content_items informados e tudo que aponta para eles ou para as suas versões (gatilhos e FKs desligados só nesta sessão). */
async function removeCommittedContent(itemIds) {
  if (!itemIds.length || !process.env.DATABASE_ADMIN_URL) return;
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  try {
    await client.query('SET session_replication_role = replica');
    const versions = (await client.query('SELECT id FROM marketing.content_versions WHERE content_item_id = ANY($1::uuid[])', [itemIds])).rows.map((r) => r.id);
    const cols = (await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'marketing' AND column_name IN ('content_item_id', 'content_version_id', 'current_version_id')`)).rows;
    for (const { table_name: t, column_name: c } of cols) {
      if (t === 'content_items') continue;
      const ids = c === 'content_item_id' ? itemIds : versions;
      if (ids.length) await client.query(`DELETE FROM marketing.${t} WHERE ${c} = ANY($1::uuid[])`, [ids]);
    }
    await client.query('DELETE FROM marketing.content_items WHERE id = ANY($1::uuid[])', [itemIds]);
  } finally {
    await client.end();
  }
}

module.exports = { removeCommittedContent };
