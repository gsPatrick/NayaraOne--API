'use strict';

// Marco 9, M9-D232 — sync de status por cursor: status externo divergente atualiza o vínculo e gera o evento properties.portal_listing.status_changed uma vez.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const env = require('../_helpers/m9d232Env');
const portal = require('../../../src/features/integrations/portal');
const store = require('../../../src/features/integrations/providers/portal/sandbox/portal.sandbox.store');
const { fetchPortalPhoto } = require('../../../src/features/integrations/portal/portal.photos');

const { sequelize, comTenant } = env;
let tenant;
let zap; let viva; let olx;
before(async () => { tenant = await env.carregar(); [zap, viva, olx] = await env.tresPortais(); });
after(async () => { await sequelize.close(); });

const publicar = (propertyId, connectionIds) => comTenant(tenant, (t) => portal.publishToPortals(env.ctxDe(tenant), { propertyId, connectionIds }, t));
const sincronizar = () => portal.syncListingStatuses({ group: env.grupo, company: env.empresa });
const eventos = (propertyId) => env.ler("SELECT * FROM integration.outbox_events WHERE company_id = :c AND event_type = 'properties.portal_listing.status_changed' AND aggregate_id = :p ORDER BY created_at", { p: propertyId });

test('portal_sync_status_divergente', async () => {
  const imovel = await env.criarImovel(tenant);
  const r = await publicar(imovel.id);
  for (const i of r.items) await env.entregar(i.dispatchId); // eslint-disable-line no-await-in-loop
  const um = await sincronizar();
  assert.ok(um.checked >= 3, 'o sync lê o status de cada vínculo, por página');
  const aposPublicar = (await eventos(imovel.id)).length;
  // o portal B reprova o anúncio depois de aceitá-lo
  const doViva = (await env.vinculos(imovel.id)).find((v) => v.connection_id === viva.id);
  store.setStatus(viva.id, doViva.external_listing_id, 'REJECTED', 'FOTO_INVALIDA');
  const dois = await sincronizar();
  assert.ok(dois.changed >= 1);
  const vs = await env.vinculos(imovel.id);
  const novo = vs.find((v) => v.connection_id === viva.id);
  assert.equal(novo.status, 'REJECTED');
  assert.match(novo.last_error, /FOTO_INVALIDA/);
  assert.deepEqual(vs.filter((v) => v.connection_id !== viva.id).map((v) => v.status), ['PUBLISHED', 'PUBLISHED'], 'a reprovação de um portal não mexe nos outros');
  const ev = await eventos(imovel.id);
  assert.equal(ev.length, aposPublicar + 1, 'um evento da mudança externa');
  assert.deepEqual([ev[ev.length - 1].payload_json.from, ev[ev.length - 1].payload_json.to, ev[ev.length - 1].payload_json.rejectionReason], ['PUBLISHED', 'REJECTED', 'FOTO_INVALIDA']);
  await sincronizar();
  assert.equal((await eventos(imovel.id)).length, aposPublicar + 1, 'sem mudança, sem evento novo');
  // o cursor do fluxo fica gravado por connection
  const cursores = await env.ler("SELECT * FROM integration.sync_cursors WHERE company_id = :c AND stream = 'portal.listing_status' AND connection_id = :con", { con: viva.id });
  assert.equal(cursores.length, 1);
  assert.equal(olx.id !== zap.id, true);
});

test('portal_foto_so_pelo_ssrf_guard', async () => {
  // a foto de anúncio enviada por URL do portal só é baixada pelo ssrfGuard.fetchExternalUrl, fluxo portal_photo (hosts na allowlist do fluxo)
  await assert.rejects(fetchPortalPhoto(env.ctxDe(tenant), 'http://fotos.portal.example/a.jpg'), (e) => /INTEGRATION_SSRF/.test(e.code));
  await assert.rejects(fetchPortalPhoto(env.ctxDe(tenant), 'https://fotos.nao-liberado.example/a.jpg'), (e) => /INTEGRATION_SSRF/.test(e.code));
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '../../../src/features/integrations/portal');
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.equal(/\bfetch\(|require\('(node:)?https?'\)|axios|got\(/.test(src), false, `${f} busca URL por fora do guarda`);
  });
});
