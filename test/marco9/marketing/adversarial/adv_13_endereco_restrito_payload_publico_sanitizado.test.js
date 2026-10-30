'use strict';

// M9-D437 adv_13 (Caderno §16: "Endereço restrito -> payload público sanitizado"). Imóvel SO_BAIRRO (rua, número e CEP no cadastro): a página do site e o JSON-LD saem só com bairro e cidade,
// sem rua nem coordenada precisa, e o payload entregue ao adapter do Instagram é sanitizado de novo mesmo quando o chamador tenta passar rua, número e coordenadas. Cenários das donas
// (M9-D403, M9-D427). Banco descartável.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { sequelize } = require('../../../../src/models');
const { getSeedTenant, withRollbackTenantTransaction } = require('../../../testHelpers');
const seo = require('../../../../src/features/marketing/publications/seo');
const { loadPublicProperty } = require('../../../../src/features/marketing/content/publicReadModel');
const { deliverToAdapter } = require('../../../../src/features/marketing/content/adapterGate');
const { SandboxChannelAdapter } = require('../../../../src/features/marketing/publications/adapters/sandbox/SandboxChannelAdapter');
const env = require('../../_helpers/mktSeoEnv');
const adv = require('../../_helpers/mktAdv');

let A;
before(async () => { A = await getSeedTenant(); });
after(async () => { await sequelize.close(); });

const SEGREDOS = ['Acácias', 'Acacias', '01310', '"120"', '-23.5', '-46.6'];
const vazou = (obj) => { const texto = JSON.stringify(obj); return SEGREDOS.filter((s) => texto.includes(s)); };

test('adv_13_endereco_restrito_payload_publico_sanitizado: site, JSON-LD e Instagram só com bairro', async () => {
  await withRollbackTenantTransaction(A, async (t) => {
    const prop = await env.makeProperty(t, A); // padrão SO_BAIRRO
    // site: a página pública e o JSON-LD
    const page = await seo.service.getPublicPage({ key: prop.public_id, now: new Date(), transaction: t });
    const ld = page.seo.jsonLd;
    assert.equal(ld.about.containedInPlace.name, 'Jardim Europa');
    assert.equal(ld.about.address.streetAddress, undefined, 'sem rua no JSON-LD');
    assert.equal(ld.about.geo, undefined, 'sem coordenada precisa no JSON-LD');
    assert.deepEqual(vazou(page), [], 'a página do site não vaza a rua, o número nem o CEP');
    // a visão pública que alimenta o conteúdo já vem sem rua nem número
    const publico = await loadPublicProperty({ propertyId: prop.id }, A, t);
    assert.equal(publico.policy, 'SO_BAIRRO');
    assert.equal(publico.payload.bairro, 'Jardim Europa');
    assert.deepEqual(vazou(publico.payload), []);
    assert.equal(publico.payload.logradouro, undefined);
    // Instagram: o chamador tenta passar rua, número e coordenada; a segunda barreira entrega só o permitido
    const instagram = new SandboxChannelAdapter('INSTAGRAM', { scope: A.companyId });
    const sujo = { ...publico.payload, logradouro: 'Rua das Acácias', numeroEndereco: '120', cep: '01310-100', latitude: -23.5614, longitude: -46.6559, enderecoPublico: 'Rua das Acácias, 120, Jardim Europa', texto: 'Casa em Jardim Europa.' };
    const entregue = await deliverToAdapter({ publish: (payload) => instagram.publish(payload, { idempotencyKey: `qa-m9-adv13-${prop.id}` }) }, 'publish', sujo, { policy: 'SO_BAIRRO', tenant: A, transaction: t });
    assert.ok(['logradouro', 'numeroEndereco', 'latitude', 'longitude', 'cep'].every((k) => entregue.removedKeys.includes(k)), `chaves removidas: ${entregue.removedKeys}`);
    const recebido = instagram.logEntries().find((e) => e.event === 'request').payload;
    assert.deepEqual(vazou(recebido), [], 'o adapter do Instagram não recebeu rua, número, CEP nem coordenada');
    assert.equal(recebido.bairro, 'Jardim Europa');
    assert.equal(entregue.result.status, 'PUBLISHED');
    // isolamento (RLS): a outra empresa não enxerga o imóvel
    await adv.assertIsolated(t, A, [{ tabela: 'real_estate.properties', ids: [prop.id] }]);
  });
});
