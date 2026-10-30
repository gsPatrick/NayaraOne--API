'use strict';

// Marco 9, M9-D231 — teste do livro "portal recebe campo interno": imóvel com valores CANARY em TODOS os campos internos,
// publicação por todas as operações de portal e site, varredura do payload gravado e do que chega ao adapter.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, ler, chave } = require('../../integrations/dispatch/dispatchHelpers');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const { createPropertyPublicationDispatch, OPERATIONS } = require('../../../src/features/integrations/publication');
const { Property } = require('../../../src/models');
const { criarImovel, CANARY, CANARY_PRICE } = require('../_helpers/intReadModel');

let tenant;
let imovel;
before(async () => {
  ({ tenant } = await carregarTenants());
  imovel = await criarImovel(tenant, { addressVisibility: 'APPROXIMATE' });
});
after(async () => { await sequelize.close(); });

const publicar = (con, propertyId, operation, extra = {}) => comTenant(tenant, (t) => createPropertyPublicationDispatch(ctxDe(tenant), { connectionId: con.id, propertyId, operation, idempotencyKey: chave(), ...extra }, t));

/** Adapter que só grava o pedido recebido: prova o que de fato chega a um adapter de portal ou site. */
function gravador(Port) {
  const recebidos = [];
  class Gravador extends Port {
    providerCode() { return 'canario-qa'; }
    capabilities() { return Object.keys(Port.operations).filter((o) => typeof this[o] === 'function'); }
    supportedVersions() { return ['v1']; }
    async healthCheck() { return { ok: true, latencyMs: 0 }; }
    classifyError() { return { class: 'UNKNOWN', code: 'x' }; }
    mapStatus(s) { return String(s); }
  }
  Object.keys(Port.operations).forEach((op) => {
    Gravador.prototype[op] = async function gravar(ctx, request) { recebidos.push({ op, request }); return { status: 'PENDING', externalResourceId: 'ext-1' }; };
  });
  return { adapter: new Gravador(null), recebidos };
}

const MARCADORES = () => [CANARY, CANARY_PRICE, 'Rua Interna', '80000-000', 'Zacarias', String(-25.4284), String(-49.2733)];

test('portal_payload_canario_sem_vazamento', async () => {
  const passos = [];
  for (const domain of ['PORTAL', 'SITE']) {
    const con = await conexao(tenant, domain);
    for (const operation of OPERATIONS[domain]) {
      const { dispatch } = await publicar(con, imovel.id, operation, { externalResourceId: 'ext-77' });
      const gravado = JSON.stringify((await ler(tenant, dispatch.id)).payload_snapshot);
      MARCADORES().forEach((m) => assert.ok(!gravado.includes(m), `${domain}.${operation}: payload gravado contém ${m}`));
      assert.ok(gravado.includes('Batel'), 'o dado público está lá');

      const { adapter, recebidos } = gravador(PORTS[domain]);
      await invoke(adapter, operation, (await ler(tenant, dispatch.id)).payload_snapshot);
      assert.equal(recebidos.length, 1, `${domain}.${operation}: o adapter recebeu o pedido`);
      const visto = JSON.stringify(recebidos[0].request);
      MARCADORES().forEach((m) => assert.ok(!visto.includes(m), `${domain}.${operation}: o adapter recebeu ${m}`));
      passos.push(`${domain}.${operation}`);
    }
  }
  assert.deepEqual(passos, ['PORTAL.publishListing', 'PORTAL.updateListing', 'SITE.publishPage']);
  // O endereço aproximado vai como coordenada deslocada, nunca o ponto exato (varrido acima).
});

test('portal_publicacao_imovel_nao_publicavel_409', async () => {
  const con = await conexao(tenant, 'PORTAL');
  const vendido = await criarImovel(tenant, { availabilityStatus: 'SOLD' });
  await assert.rejects(publicar(con, vendido.id, 'publishListing'), (e) => e.statusCode === 409 && e.code === 'INTEGRATION_PROPERTY_NOT_PUBLISHABLE' && e.message === 'Este imóvel não atende às condições para publicação.');
  const rascunho = await criarImovel(tenant, { publicationStatus: 'DRAFT' });
  await assert.rejects(publicar(con, rascunho.id, 'publishListing'), (e) => e.code === 'INTEGRATION_PROPERTY_NOT_PUBLISHABLE');
  const n = await comTenant(tenant, async (t) => (await sequelize.query("SELECT count(*)::int AS n FROM integration.dispatches WHERE aggregate_id IN (:a, :b)", { replacements: { a: vendido.id, b: rascunho.id }, transaction: t }))[0][0].n);
  assert.equal(n, 0, 'nenhum envio gravado');
  // Operação que não publica imóvel neste fornecedor.
  await assert.rejects(publicar(con, imovel.id, 'getListingStatus'), (e) => e.code === 'INTEGRATION_OPERATION_UNSUPPORTED');
  const banco = await conexao(tenant, 'BANK');
  await assert.rejects(publicar(banco, imovel.id, 'publishListing'), (e) => e.code === 'INTEGRATION_OPERATION_UNSUPPORTED');
});

test('portal_publicacao_registra_quem_autorizou_e_a_finalidade', async () => {
  const con = await conexao(tenant, 'SITE');
  const { dispatch } = await publicar(con, imovel.id, 'publishPage');
  const linha = await ler(tenant, dispatch.id);
  assert.equal(linha.created_by, tenant.userId, 'quem autorizou');
  assert.equal(linha.purpose, 'SITE_PUBLICATION');
  assert.equal(linha.aggregate_id, imovel.id);
  assert.equal(linha.aggregate_type, 'Property');
  const lido = linha.payload_snapshot;
  assert.equal(lido.slug, lido.public_code.toLowerCase());
  const antes = await comTenant(tenant, (t) => Property.findByPk(imovel.id, { transaction: t }));
  assert.ok(antes, 'o imóvel segue existindo');
});

// M9-D232: o mesmo teste do livro roda sobre os adapters de portal reais da demanda (A, B e C sandbox) e sobre o portal-sandbox: o que o adapter recebe e guarda não tem CANARY.
test('portal_payload_canario_sem_vazamento_adapters_de_portal', async () => {
  const portalEnv = require('../_helpers/m9d232Env');
  const portal = require('../../../src/features/integrations/portal');
  const store = require('../../../src/features/integrations/providers/portal/sandbox/portal.sandbox.store');
  await portalEnv.carregar();
  const portais = await portalEnv.tresPortais();
  const r = await comTenant(tenant, (t) => portal.publishToPortals(ctxDe(tenant), { propertyId: imovel.id }, t));
  assert.equal(r.items.length, 3);
  for (const i of r.items) await portalEnv.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  await portal.syncListingStatuses({ group: portalEnv.grupo, company: portalEnv.empresa });
  for (const v of await portalEnv.vinculos(imovel.id)) {
    const visto = JSON.stringify(store.lastPayload(v.connection_id, v.external_listing_id));
    MARCADORES().forEach((m) => assert.ok(!visto.includes(m), `${v.provider_code}: o adapter recebeu ${m}`));
    assert.ok(visto.includes('Batel'), 'o dado público chega ao portal');
  }
  // o portal-sandbox (D210) recebe o mesmo pedido minimizado e também não vê nada interno
  const { dispatch } = await publicar(await conexao(tenant, 'PORTAL'), imovel.id, 'publishListing');
  const { adapter, recebidos } = gravador(PORTS.PORTAL);
  await invoke(adapter, 'publishListing', (await ler(tenant, dispatch.id)).payload_snapshot);
  MARCADORES().forEach((m) => assert.ok(!JSON.stringify(recebidos[0].request).includes(m), `portal-sandbox: o adapter recebeu ${m}`));
  assert.equal(portais.length, 3);
});
