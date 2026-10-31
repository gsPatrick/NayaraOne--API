'use strict';

// Marco 9, M9-D211 (reabertura G1) — a deduplicação da caixa de entrada de webhooks é POR EMPRESA: o mesmo id externo do mesmo fornecedor em duas
// empresas grava duas linhas e responde `accepted` nas duas; o `duplicate` nunca vira oráculo de existência entre empresas. Banco descartável.
process.env.PORT = process.env.M9D211_EMPRESAS_PORT || require('../_helpers/portaLivre').portaLivre();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d211Env');

let tenant;
let outro;
let desligarCofre;

before(async () => {
  const t = await env.carregarTenants();
  tenant = t.tenant;
  outro = t.outro;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

const enviar = (c, corpo) => {
  const bruto = Buffer.from(corpo, 'utf8');
  return env.postar(`/v1/webhooks/${c.provider}/${c.canal}`, bruto, env.assinar(c.segredo, bruto));
};

test('webhook_dedup_por_empresa_mesmo_id_em_duas_empresas', async () => {
  assert.ok(outro, 'o seed de duas empresas precisa existir no banco descartável');
  const a = await env.criarCanal(tenant);
  const b = await env.criarCanal(outro);
  const id = `evt-d211-g1-${env.uniqueSuffix()}`;
  const corpoA = `{"id":"${id}","type":"payment.paid","n":"A"}`;
  const corpoB = `{"id":"${id}","type":"payment.paid","n":"B"}`;

  const ra = await enviar(a, corpoA);
  assert.deepEqual([ra.status, ra.json.status], [200, 'accepted']);
  const rb = await enviar(b, corpoB);
  assert.deepEqual([rb.status, rb.json.status], [200, 'accepted'], 'o id usado pela empresa A não descarta o evento da empresa B');

  const [linhaA] = await env.inbox(tenant, a.provider, id);
  const [linhaB] = await env.inbox(outro, b.provider, id);
  assert.equal(linhaA.company_id, tenant.companyId);
  assert.equal(linhaB.company_id, outro.companyId);
  assert.notEqual(linhaA.payload_hash, linhaB.payload_hash, 'cada empresa guarda o seu corpo');
  assert.equal((await env.inbox(tenant, a.provider, id)).length, 1, 'a empresa A enxerga só a sua linha');

  const repA = await enviar(a, corpoA);
  const repB = await enviar(b, corpoB);
  assert.equal(repA.json.status, 'duplicate', 'dentro da mesma empresa o repetido segue duplicate');
  assert.equal(repB.json.status, 'duplicate');
  assert.equal((await env.inbox(outro, b.provider, id)).length, 1);
});

test('webhook_dedup_unique_do_banco_tem_a_empresa_na_chave', async () => {
  const [def] = await env.sql(tenant, `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'integration' AND t.relname = 'webhook_inbox' AND c.contype = 'u'`);
  assert.match(def.def, /UNIQUE \(company_id, provider_code, external_event_id\)/);
});
