'use strict';

// Marco 9, M9-D252 — teste adversarial 11 do livro (seção 19): imóvel com valores CANARY em todos os campos internos; nenhum chega ao payload gravado nem ao que o adapter de nenhum portal
// ou site sandbox recebe (portais A, B, C, portal-sandbox e site-sandbox). Banco descartável (os testes COMMITAM).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize, comTenant, carregarTenants, ctxDe, conexao, ler, chave } = require('../../integrations/dispatch/dispatchHelpers');
const { PORTS } = require('../../../src/features/integrations/providers/ports');
const { invoke } = require('../../../src/features/integrations/registry/adapterInvoke');
const { createPropertyPublicationDispatch, OPERATIONS } = require('../../../src/features/integrations/publication');
const { criarImovel, CANARY, CANARY_PRICE } = require('../_helpers/intReadModel');

let tenant;
let imovel;
before(async () => {
  ({ tenant } = await carregarTenants());
  imovel = await criarImovel(tenant, { addressVisibility: 'APPROXIMATE' });
});
after(async () => { await sequelize.close(); });

// Coordenada exata do ponto interno: casa só o número inteiro, sem confundir com uma coordenada aproximada que começa com os mesmos dígitos (ex.: -25.42841...).
const COORDENADAS = [/-25\.4284(?!\d)/, /-49\.2733(?!\d)/];
const MARCADORES = () => [CANARY, CANARY_PRICE, 'Rua Interna', '80000-000', 'Zacarias'];
const publicar = (con, operation, extra = {}) => comTenant(tenant, (t) => createPropertyPublicationDispatch(ctxDe(tenant), { connectionId: con.id, propertyId: imovel.id, operation, idempotencyKey: chave(), ...extra }, t));

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
  Object.keys(Port.operations).forEach((op) => { Gravador.prototype[op] = async function gravar(ctx, request) { recebidos.push({ op, request }); return { status: 'PENDING', externalResourceId: 'ext-1' }; }; });
  return { adapter: new Gravador(null), recebidos };
}

test('adv_portal_recebe_campo_interno_canario_ausente', async () => {
  const sem = (texto, onde) => {
    MARCADORES().forEach((m) => assert.ok(!texto.includes(m), `${onde} contém ${m}`));
    COORDENADAS.forEach((re) => assert.ok(!re.test(texto), `${onde} contém a coordenada exata ${re}`));
  };
  // Portal e site sandbox genéricos, em todas as operações que publicam imóvel.
  const passos = [];
  for (const domain of ['PORTAL', 'SITE']) {
    const con = await conexao(tenant, domain);
    for (const operation of OPERATIONS[domain]) {
      const { dispatch } = await publicar(con, operation, { externalResourceId: 'ext-77' });
      const linha = await ler(tenant, dispatch.id);
      const gravado = JSON.stringify(linha.payload_snapshot);
      sem(gravado, `${domain}.${operation}: payload gravado`);
      assert.ok(gravado.includes('Batel'), 'o dado público está lá');
      const { adapter, recebidos } = gravador(PORTS[domain]);
      await invoke(adapter, operation, linha.payload_snapshot);
      assert.equal(recebidos.length, 1);
      sem(JSON.stringify(recebidos[0].request), `${domain}.${operation}: o adapter recebeu`);
      passos.push(`${domain}.${operation}`);
    }
  }
  assert.deepEqual(passos, ['PORTAL.publishListing', 'PORTAL.updateListing', 'SITE.publishPage']);

  // Os três portais reais da demanda (A, B e C sandbox): o que o adapter guardou ao receber não tem canário.
  const portalEnv = require('../_helpers/m9d232Env');
  const portal = require('../../../src/features/integrations/portal');
  const store = require('../../../src/features/integrations/providers/portal/sandbox/portal.sandbox.store');
  await portalEnv.carregar();
  await portalEnv.tresPortais();
  const r = await comTenant(tenant, (t) => portal.publishToPortals(ctxDe(tenant), { propertyId: imovel.id }, t));
  assert.equal(r.items.length, 3);
  for (const i of r.items) await portalEnv.entregar(i.dispatchId);
  await portal.syncListingStatuses({ group: portalEnv.grupo, company: portalEnv.empresa });
  const vinculos = await portalEnv.vinculos(imovel.id);
  assert.ok(vinculos.length >= 3, 'os três portais receberam o imóvel');
  for (const v of vinculos) {
    const visto = JSON.stringify(store.lastPayload(v.connection_id, v.external_listing_id));
    sem(visto, `${v.provider_code}: o portal recebeu`);
    assert.ok(visto.includes('Batel'), 'o dado público chega ao portal');
  }
});
