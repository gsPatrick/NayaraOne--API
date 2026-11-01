'use strict';

// M9-D870 (reabertura F05) — a tela de Atividades precisa saber QUAL chave mudou: a foto de auditoria da flag traz a chave junto do antes e do depois.
process.env.PORT = process.env.M9D870_ATIV_TEST_PORT || '21871';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('../_helpers/m9d870Http');

before(async () => { await http.start(); });
after(async () => {
  if (!http.state.skip) {
    await http.adminQuery("DELETE FROM governance.flag_versions WHERE key LIKE 'qa.m9d870.ativ_%'");
    await http.adminQuery("DELETE FROM governance.feature_flags WHERE key LIKE 'qa.m9d870.ativ_%'");
  }
  await http.stop();
});

test('m9d870 auditoria da flag traz a chave no antes e no depois (uma linha por ato)', async (t) => {
  if (http.state.skip) return t.skip(http.state.skip);
  const { A } = http.state.tenants;
  const key = `qa.m9d870.ativ_${Date.now().toString(36)}`;
  const created = await http.call('A:gestor', 'POST', '/feature-flags', { key, value: false, ownerUserId: A.userId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const patched = await http.call('A:gestor', 'PATCH', '/feature-flags', { id: created.body.data.id, version: 1, value: true, reason: 'Liberar.' });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const rows = (await http.adminQuery("SELECT before_json, after_json FROM audit.audit_log WHERE entity_id = $1 AND action = 'governance.flag.changed' ORDER BY occurred_at", [created.body.data.id])).rows;
  assert.equal(rows.length, 2, 'criação e alteração: uma linha cada');
  assert.equal(rows[0].after_json.key, key);
  assert.deepEqual([rows[1].before_json.key, rows[1].after_json.key, rows[1].before_json.value, rows[1].after_json.value], [key, key, false, true]);
});
