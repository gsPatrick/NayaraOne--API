'use strict';

// M9-D429 (reabertura da auditoria cega, M-2 e L-3): a verificação do link de descadastro SÓ LÊ o cofre (token de empresa inventada não cria segredo) e,
// com o cofre fora, o descadastro segue com a última chave lida com sucesso (TTL do cofre) em vez de falhar. Dados COMMITADOS, apagados no after.
process.env.PORT = process.env.M9D429_COFRE_PORT || '21459';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const env = require('../_helpers/m9d211Env');
const aiEnv = require('../_helpers/aiHttpEnv');
const msg = require('../_helpers/mktMsgEnv');
const { setSecretStoreForTests, getSecretStore } = require('../../../src/features/integrations/secrets');
const { keyRef, verifyUnsubscribeToken, clearUnsubscribeKeyCache } = require('../../../src/features/marketing/publications/messaging/unsubscribe/unsubscribe.token');

let tenant; let offVault; const personIds = [];
before(async () => {
  ({ tenant } = await env.carregarTenants());
  offVault = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => {
  for (const id of personIds) {
    for (const sql of ['DELETE FROM marketing.suppression_list WHERE person_id = $1', 'DELETE FROM crm.messages WHERE person_id = $1', 'DELETE FROM people.communication_consents WHERE person_id = $1',
      'DELETE FROM people.person_contacts WHERE person_id = $1', 'DELETE FROM people.persons WHERE id = $1']) await aiEnv.admin(sql, [id]).catch(() => {});
  }
  offVault();
  await env.sequelize.close();
  process.exit(0);
});

const committedPerson = async () => {
  const id = await env.comTenant(tenant, (t) => msg.readyPerson(t, tenant));
  personIds.push(id);
  return id;
};
const exists = async (companyId) => {
  try { await getSecretStore().get(keyRef(companyId)); return true; } catch (err) { if (err.code === 'INTEGRATION_SECRET_NOT_FOUND') return false; throw err; }
};
const brokenStore = () => ({ driver: 'file', get: async () => { throw new Error('cofre fora'); }, put: async () => { throw new Error('cofre fora'); } });

test('token_de_empresa_inventada_nao_cria_segredo_no_cofre', { skip: aiEnv.SKIP }, async () => {
  const fake = crypto.randomUUID();
  const token = `v1.${fake}.${crypto.randomUUID()}.EMAIL.${'0'.repeat(64)}`;
  assert.equal(await verifyUnsubscribeToken(token), null);
  assert.equal(await exists(fake), false, 'a verificação direta não escreve no cofre');
  const r = await env.postar('/v1/marketing/unsubscribe', JSON.stringify({ token }));
  assert.deepEqual([r.status, r.json.error.code], [404, 'MKT_UNSUBSCRIBE_LINK_INVALID']);
  assert.equal(await exists(fake), false, 'a rota pública também não');
  // empresa real sem chave ainda (nunca assinou): MAC qualquer é só "inválido", e continua sem chave
  const other = tenant.companyId;
  const personId = await committedPerson();
  const bad = `v1.${other}.${personId}.EMAIL.${'f'.repeat(64)}`;
  assert.equal(await verifyUnsubscribeToken(bad), null);
});

test('cofre_fora_usa_a_ultima_chave_lida_e_sem_ela_responde_503', { skip: aiEnv.SKIP }, async () => {
  const { signUnsubscribeToken } = msg.messaging;
  const [p1, p2] = [await committedPerson(), await committedPerson()];
  const t1 = await signUnsubscribeToken({ companyId: tenant.companyId, personId: p1, channel: 'EMAIL' });
  const t2 = await signUnsubscribeToken({ companyId: tenant.companyId, personId: p2, channel: 'EMAIL' });
  clearUnsubscribeKeyCache();
  const url = '/v1/marketing/unsubscribe';
  assert.equal((await env.postar(url, JSON.stringify({ token: t1 }))).status, 200, 'cofre no ar: lê e guarda a chave');
  setSecretStoreForTests(brokenStore());
  const degraded = await env.postar(url, JSON.stringify({ token: t2 }));
  assert.equal(degraded.status, 200, JSON.stringify(degraded.json));
  assert.equal(degraded.json.data.unsubscribed, true);
  assert.equal((await aiEnv.admin("SELECT 1 FROM marketing.suppression_list WHERE person_id = $1 AND reason = 'OPT_OUT'", [p2])).rows.length, 1);
  // um token adulterado continua inválido no modo degradado
  const [v, c, p, ch] = t2.split('.');
  assert.equal((await env.postar(url, JSON.stringify({ token: `${v}.${c}.${p}.${ch}.${'0'.repeat(64)}` }))).status, 404);
  // sem chave em memória, o cofre fora é 503 honesto
  clearUnsubscribeKeyCache();
  const p3 = await committedPerson();
  const t3 = `v1.${tenant.companyId}.${p3}.EMAIL.${'a'.repeat(64)}`;
  const down = await env.postar(url, JSON.stringify({ token: t3 }));
  assert.deepEqual([down.status, down.json.error.code], [503, 'MKT_UNSUBSCRIBE_KEY_UNAVAILABLE']);
  assert.equal((await aiEnv.admin('SELECT 1 FROM marketing.suppression_list WHERE person_id = $1', [p3])).rows.length, 0);
});
