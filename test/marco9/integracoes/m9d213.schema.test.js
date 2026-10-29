'use strict';

// Marco 9, M9-D213 — esquema por tipo e versão (Ajv): campo crítico estrito, tipos e enum; todo adapter com verificador publica esquema.
process.env.PORT = process.env.M9D213_SCHEMA_PORT || '21217';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d212Env');
const adapterRegistry = require('../../../src/features/integrations/registry/adapterRegistry');

let tenant;
let desligarCofre;
before(async () => {
  tenant = (await env.carregarTenants()).tenant;
  desligarCofre = env.useTempSecretStore();
  await new Promise((resolve) => { setTimeout(resolve, 300); });
});
after(async () => { desligarCofre(); await env.sequelize.close(); process.exit(0); });

test('schema_estrito_rejeita_campo_extra_critico', async () => {
  const c = await env.criarCanal(tenant);
  const casos = [
    ['campo extra no valor monetário', env.evento({ amount: { value: 10, currency: 'BRL', extra: 'x' } })],
    ['moeda fora do enum', env.evento({ amount: { value: 10, currency: 'USD' } })],
    ['tipo errado (número no lugar de texto)', env.evento({ resourceId: 12345 })],
    ['texto acima do tamanho', env.evento({ resourceId: 'r'.repeat(161) })],
  ];
  for (const [rotulo, ev] of casos) {
    await env.enviar(c, ev);
    await env.rodar(tenant);
    const l = await env.linha(tenant, c.provider, ev.id);
    assert.deepEqual([l.status, l.dead_letter_reason, l.attempts], ['DEAD_LETTER', 'SCHEMA_INVALID', 1], rotulo);
  }
  const bom = env.evento({ amount: { value: 10.5, currency: 'BRL' }, extraPermitidoFora: 'ok' });
  await env.enviar(c, bom);
  await env.rodar(tenant);
  assert.equal((await env.linha(tenant, c.provider, bom.id)).status, 'PROCESSED', 'o campo crítico estrito não impede campos novos fora dele');
});

test('schema_todo_adapter_com_verificador_publica_esquema_por_versao', () => {
  const comVerificador = adapterRegistry.list().map((a) => adapterRegistry.instantiate(a.providerCode)).filter((a) => a && a.webhookVerifier());
  assert.equal(comVerificador.length >= 3, true);
  for (const adapter of comVerificador) {
    const esquemas = adapter.webhookSchemas();
    assert.ok(esquemas && typeof esquemas === 'object', `${adapter.providerCode()} publica webhookSchemas()`);
    for (const versao of adapter.supportedVersions()) {
      assert.ok(Object.values(esquemas).some((porVersao) => porVersao[versao]), `${adapter.providerCode()} tem esquema para ${versao}`);
    }
  }
});
