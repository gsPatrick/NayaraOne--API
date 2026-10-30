'use strict';

// M9-D427 — a rota pública GET /public/properties/:publicId por HTTP real (sem login): 200 com metadata e JSON-LD sanitizados, 200 noindex com selo,
// 301 para a listagem e 410 para removido; e o sitemap autenticado, isolado por empresa e gerado com trava. Os dados são COMMITADOS e removidos no
// fim. Só em banco descartável; nenhum endpoint de MFA é chamado nem token forjado.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/aiHttpEnv');

let ctx; let port; let tenants;
const criados = [];
after(async () => {
  for (const id of criados) {
    await env.admin('DELETE FROM real_estate.property_offers WHERE property_id = $1', [id]).catch(() => {});
    await env.admin('DELETE FROM real_estate.properties WHERE id = $1', [id]).catch(() => {});
  }
  await env.admin("DELETE FROM real_estate.property_addresses WHERE zip_code = '01310-427'").catch(() => {});
  if (ctx) setTimeout(() => process.exit(0), 300);
});

async function setup() {
  if (ctx) return;
  await env.grant('CI LEITURA', ['marketing:content:read']);
  port = process.env.M9D427_HTTP_TEST_PORT || '21427';
  ctx = await env.startHttpEnv(port, [['A', 'leitura'], ['B', 'leitura']]);
  const { emailFor } = require('../../../scripts/seed-ci-two-tenants');
  tenants = {};
  for (const t of ['A', 'B']) {
    const row = (await env.admin('SELECT m.group_id, m.company_id FROM core.user_memberships m JOIN core.users u ON u.id = m.user_id WHERE u.email = $1', [emailFor(t, 'leitura')])).rows[0];
    tenants[t] = { groupId: row.group_id, companyId: row.company_id };
  }
}

async function publish(t, { sold = false, bairro = 'Jardim Europa' } = {}) {
  const { groupId, companyId } = tenants[t];
  const addr = (await env.admin(`INSERT INTO real_estate.property_addresses (id, zip_code, street, number, neighborhood, city, state)
    VALUES (gen_random_uuid(), '01310-427', 'Rua Sigilosa', '777', $1, 'São Paulo', 'SP') RETURNING id`, [bairro])).rows[0].id;
  const prop = (await env.admin(`INSERT INTO real_estate.properties (id, group_id, company_id, title, internal_code, property_type, address_id, bedrooms, parking_spots, area_total_m2, publication_status)
    VALUES (gen_random_uuid(), $1, $2, 'Apto sigiloso', $3, 'RESIDENTIAL', $4, 2, 1, 80, 'PUBLISHED') RETURNING id, public_id`, [groupId, companyId, `QA-M9-${Math.random().toString(36).slice(2, 10)}`, addr])).rows[0];
  await env.admin(`INSERT INTO real_estate.property_offers (id, group_id, company_id, property_id, offer_type, asking_price, status)
    VALUES (gen_random_uuid(), $1, $2, $3, 'SALE', 500000, 'ACTIVE')`, [groupId, companyId, prop.id]);
  criados.push(prop.id);
  if (sold) await env.admin("UPDATE real_estate.properties SET availability_status = 'SOLD' WHERE id = $1", [prop.id]);
  return prop;
}
const get = (publicId) => fetch(`http://127.0.0.1:${port}/api/v1/public/properties/${publicId}`, { redirect: 'manual' });
const setChanged = (id, interval) => env.admin(`UPDATE real_estate.properties SET lifecycle_changed_at = now() - interval '${interval}' WHERE id = $1`, [id]);

test('rota_publica_responde_200_301_e_410_sem_login', { skip: env.SKIP }, async () => {
  await setup();
  const ativo = await publish('A');
  const ok = await get(ativo.public_id);
  assert.equal(ok.status, 200);
  const body = (await ok.json()).data;
  assert.equal(body.http, 200);
  assert.equal(body.seo.jsonLd['@type'], 'RealEstateListing');
  assert.ok(!JSON.stringify(body).includes('Sigilosa') && !JSON.stringify(body).includes('777'), 'endereço restrito não vaza na resposta pública');
  assert.equal(ok.headers.get('x-robots-tag'), null);
  // invalidação por URL: tempo de cache do parâmetro, Last-Modified da página e revalidação condicional pelo ETag (304)
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=60, must-revalidate');
  assert.ok(ok.headers.get('last-modified'));
  const again = await fetch(`http://127.0.0.1:${port}/api/v1/public/properties/${ativo.public_id}`, { headers: { 'If-None-Match': ok.headers.get('etag') }, cache: 'no-cache' });
  assert.equal(again.status, 304);

  const vendido = await publish('A', { sold: true });
  await setChanged(vendido.id, '2 days');
  const selo = await get(vendido.public_id);
  assert.equal(selo.status, 200);
  assert.equal(selo.headers.get('x-robots-tag'), 'noindex, nofollow');
  const seloBody = (await selo.json()).data;
  assert.deepEqual([seloBody.selo, seloBody.indexable], ['Vendido', false]);

  await setChanged(vendido.id, '45 days');
  const redirect = await get(vendido.public_id);
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('location'), '/imoveis/venda/residencial/jardim-europa');

  const removido = await publish('A');
  await env.admin("UPDATE real_estate.properties SET availability_status = 'WITHDRAWN' WHERE id = $1", [removido.id]);
  const gone = await get(removido.public_id);
  assert.equal(gone.status, 410);
  assert.equal((await gone.json()).error.code, 'MKT_PAGE_GONE');

  for (const bad of ['nao-e-uuid', '00000000-0000-4000-8000-000000000000']) assert.equal((await get(bad)).status, 404);
});

test('sitemap_so_lista_paginas_ativas_da_propria_empresa_e_a_geracao_concorrente_e_consistente', { skip: env.SKIP }, async () => {
  await setup();
  const minha = await publish('A');
  const vendida = await publish('A', { sold: true });
  const deB = await publish('B', { bairro: 'Bairro da Outra Empresa' });
  const respostas = await Promise.all(Array.from({ length: 5 }, () => ctx.call('GET', '/marketing/seo/sitemap', ctx.tokens['A:leitura'])));
  for (const r of respostas) assert.equal(r.status, 200, JSON.stringify(r.body));
  const xmls = new Set(respostas.map((r) => r.body.data.xml));
  assert.equal(xmls.size, 1, 'gerações simultâneas devolvem o mesmo documento, nunca meia lista');
  const xml = respostas[0].body.data.xml;
  assert.ok(xml.includes(minha.public_id), 'página ativa entra');
  assert.ok(!xml.includes(vendida.public_id), 'vendida sai do sitemap');
  assert.ok(!xml.includes(deB.public_id) && !xml.includes('outra-empresa'), 'página de outra empresa nunca aparece');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal((await ctx.call('GET', '/marketing/seo/sitemap', undefined)).status, 401);
});
