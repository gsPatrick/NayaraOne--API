'use strict';

// Livro do Marco 3 §19 "Testes adversariais": os 15 CRM-TS, cada um com o nome do livro (Teste — Tema — Cenário — Resultado), pela ROTA
// sempre que o cenário tem rota. Empresa "Dev" do seed (gestor com as permissões, token assinado como os demais testes de rota do Marco 3)
// e empresas A/B do seed de dois tenants (login real) para carteira e empresa. CRM-TS-009 roda a cadência de verdade (runner de Marketing).
// Banco descartável: node scripts/withDisposableDb.js --port <p> -- ... node --test test/m3.crmTs.livro.http.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/m3cbCarteiraEnv');
const T = require('./helpers/m3CrmTsEnv');

let env; let dev;
const as = (who) => env.tokens[`A:${who}`];

before(async () => {
  if (!H.DISPOSABLE) return;
  env = await H.subir(Number(process.env.M3CB_CRMTS_HTTP_PORT) || 34232, { gestor: ['governance:dlp:export', 'ai:admin', 'ai:use', 'ai:read', 'ai:budget', 'settings:read', 'settings:update'], maker: ['governance:dlp:export', 'ai:use', 'ai:read', 'properties:read'] });
  dev = await T.devGestor(env);
});
after(async () => { if (H.DISPOSABLE && env) await H.encerrar(); });

test('CRM-TS-001 CPF duplicado — Criar mesma pessoa — Bloqueio/reuso', { skip: H.SKIP }, async () => {
  const doc = T.cpf();
  const primeira = await dev.call('POST', '/people', { personType: 'PF', legalName: H.unique('Pessoa CPF'), taxIdNormalized: doc });
  assert.equal(primeira.status, 201, JSON.stringify(primeira.body));
  for (const extra of [{}, { allowDuplicate: true }]) {
    const segunda = await dev.call('POST', '/people', { personType: 'PF', legalName: H.unique('Mesma pessoa'), taxIdNormalized: doc, ...extra });
    assert.equal(segunda.status, 409, JSON.stringify(segunda.body));
    assert.match(segunda.body.error.code, /^PERSON_DUPLICATE/);
  }
  assert.equal(await T.count('SELECT count(*)::int AS n FROM people.persons WHERE tax_id_normalized = $1', [doc]), 1, 'um CPF, um cadastro');
});

test('CRM-TS-002 Merge errado — CPFs conflitantes — Bloqueado', { skip: H.SKIP }, async () => {
  const a = await dev.call('POST', '/people', { personType: 'PF', legalName: H.unique('Canônica'), taxIdNormalized: T.cpf() });
  const b = await dev.call('POST', '/people', { personType: 'PF', legalName: H.unique('Absorvida'), taxIdNormalized: T.cpf() });
  const merge = await dev.call('POST', `/people/${a.body.data.id}/merge`, { absorbedId: b.body.data.id });
  assert.ok([409, 422].includes(merge.status), JSON.stringify(merge.body));
  assert.equal(merge.body.error.code, 'PERSON_MERGE_CONFLICT');
  assert.equal(await T.count("SELECT count(*)::int AS n FROM people.persons WHERE id = $1 AND merged_into_id IS NULL AND deleted_at IS NULL", [b.body.data.id]), 1, 'nada foi absorvido');
});

test('CRM-TS-003 Property duplicate — Mesma matrícula — Revisão/bloqueio', { skip: H.SKIP }, async () => {
  const matricula = `MAT-${Date.now()}`;
  assert.equal((await T.imovel(dev, { registryNumber: matricula })).status, 201);
  const dup = await T.imovel(dev, { registryNumber: matricula });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  assert.equal(dup.body.error.code, 'PROPERTY_REGISTRY_NUMBER_DUPLICATE');
});

test('CRM-TS-004 Sale+rent — Mesmo imóvel — 1 property, 2 offers', { skip: H.SKIP }, async () => {
  const casa = (await T.imovel(dev)).body.data;
  for (const [offerType, askingPrice] of [['SALE', 650000], ['RENT', 3200]]) assert.equal((await dev.call('POST', `/properties/${casa.id}/offers`, { offerType, askingPrice })).status, 201);
  const ofertas = (await dev.call('GET', `/properties/${casa.id}/offers`)).body.data;
  assert.deepEqual(ofertas.map((o) => o.offerType).sort(), ['RENT', 'SALE']);
  assert.ok(ofertas.every((o) => o.propertyId === casa.id), 'as duas ofertas apontam para o mesmo imóvel físico');
});

test('CRM-TS-005 Publish no video — Regra exige vídeo — Bloqueado', { skip: H.SKIP }, async () => {
  const casa = (await T.imovel(dev)).body.data;
  const oferta = (await dev.call('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 500000 })).body.data;
  const r = await dev.call('POST', `/offers/${oferta.id}/publish`, {});
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'PROPERTY_PUBLISH_BLOCKED_REG_IMO_001');
});

test('CRM-TS-006 Internal leak — Portal consulta ocorrência interna — Nunca retorna', { skip: H.SKIP }, async () => {
  const segredo = `SEGREDO-${Date.now()}`;
  const casa = (await T.imovel(dev)).body.data;
  assert.ok([200, 201].includes((await dev.call('POST', `/properties/${casa.id}/occurrences`, { occurrenceType: 'SPECIFIC_NEGOTIATION', description: `${segredo} aceita permuta` })).status));
  const leitor = await dev.as(['properties:read']);
  for (const rota of [`/properties/${casa.id}`, '/properties']) assert.doesNotMatch(JSON.stringify((await leitor('GET', rota)).body), new RegExp(segredo), rota);
  const { personId } = await T.pessoaDev(dev);
  const op = (await dev.call('POST', '/opportunities', { personId, stage: 'NEW', nextAction: 'Enviar opções', nextActionDueAt: H.FUTURE() })).body.data;
  const cart = (await dev.call('POST', `/opportunities/${op.id}/carts`, { propertyIds: [casa.id] })).body.data;
  const link = await dev.call('POST', `/carts/${cart.id || cart.cart.id}/share-link`);
  const publico = await T.publico(dev, `/crm/carts/public/${link.body.data.token}`);
  assert.equal(publico.status, 200);
  assert.doesNotMatch(JSON.stringify(publico.body), new RegExp(segredo), 'a consulta pública nunca devolve a ocorrência interna');
});

test('CRM-TS-007 Lead no next action — Open sem tarefa — Bloqueado', { skip: H.SKIP }, async () => {
  const { personId } = await T.pessoaDev(dev);
  const r = await dev.call('POST', '/opportunities', { personId, stage: 'NEW' });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'OPPORTUNITY_NEXT_ACTION_REQUIRED');
  assert.equal(await T.count('SELECT count(*)::int AS n FROM crm.opportunities WHERE person_id = $1', [personId]), 0);
});

test('CRM-TS-008 Lost no reason — Marcar LOST — Bloqueado', { skip: H.SKIP }, async () => {
  const { personId } = await T.pessoaDev(dev);
  const op = (await dev.call('POST', '/opportunities', { personId, stage: 'QUALIFIED', nextAction: 'Ligar', nextActionDueAt: H.FUTURE() })).body.data;
  const r = await dev.call('POST', `/crm/opportunities/${op.id}/lost`, {});
  assert.ok([400, 422].includes(r.status), JSON.stringify(r.body));
  assert.match(r.body.error.code, /REASON/);
  assert.equal((await dev.call('GET', `/opportunities/${op.id}`)).body.data.stage, 'QUALIFIED', 'continua aberta');
});

test('CRM-TS-009 Opt-out — Cadência tenta enviar — Bloqueado', { skip: H.SKIP }, async () => {
  const r = await T.cadenciaComOptOut();
  assert.ok(r.runs >= 1, 'a cadência tentou enviar');
  assert.equal(r.enviados, 0);
  assert.ok(r.motivos.every((m) => m === 'SUPPRESSED'), JSON.stringify(r.motivos));
});

test('CRM-TS-010 Radar duplicate — Mesmo match reprocessado — Não duplica', { skip: H.SKIP }, async () => {
  const r = await T.radarReprocessado(dev);
  assert.equal(r.matchesDepois1, 1, 'o match foi gravado');
  assert.equal(r.matchesDepois2, 1, 'reprocessar não duplica o match');
  assert.equal(r.eventosDepois2, r.eventosDepois1, 'nem o evento crm.radar.match.created');
});

test('CRM-TS-011 AI hallucination — Campo ausente — Descrição não inventa', { skip: H.SKIP }, async () => {
  const r = await T.descricaoSemCampo(env, await H.companyA());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.texto, /^RASCUNHO/);
  assert.match(r.texto, /cidade: Curitiba/, 'o que está no cadastro entra');
  assert.doesNotMatch(r.texto, /m²|metr|quarto|vaga|suíte|piscina/i, 'nenhum atributo ausente no cadastro aparece na descrição');
});

test('CRM-TS-012 Cross company — Corretor A lê B — Bloqueado', { skip: H.SKIP }, async () => {
  const deB = await H.oportunidadeDe(env, env.ids.checker, 'Carteira de B');
  for (const rota of [`/opportunities/${deB.opportunityId}`, `/opportunities/${deB.opportunityId}/timeline`, `/messages?opportunityId=${deB.opportunityId}`]) {
    const r = await env.call('GET', rota, as('maker'));
    assert.equal(r.status, 404, `corretor A na carteira de B: ${rota}`);
  }
  const outraEmpresa = await dev.call('GET', `/opportunities/${deB.opportunityId}`);
  assert.equal(outraEmpresa.status, 404, 'gestor de OUTRA empresa também não lê');
});

test('CRM-TS-013 Mass export — Sem permissão — Negado', { skip: H.SKIP }, async () => {
  await H.mfaRecente(env.ids.maker, (await H.companyA()).id);
  const r = await env.call('POST', '/exports', as('maker'), { resourceType: 'crm.opportunities', format: 'CSV', purpose: 'OPERACAO', justification: 'Planilha de toda a base de clientes para uso pessoal' }, { 'Idempotency-Key': `crmts013-${Date.now()}-abcdefgh` });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'GOV_DLP_PERMISSION');
  await H.semMfa(env.ids.maker);
});

test('CRM-TS-014 Price race — 2 alterações simultâneas — Lock/version history correto', { skip: H.SKIP }, async () => {
  const casa = (await T.imovel(dev)).body.data;
  const oferta = (await dev.call('POST', `/properties/${casa.id}/offers`, { offerType: 'SALE', askingPrice: 300000 })).body.data;
  const [a, b] = await Promise.all([310000, 320000].map((askingPrice) => dev.call('PATCH', `/properties/${casa.id}/offers/${oferta.id}`, { askingPrice })));
  assert.ok([a.status, b.status].every((s) => s === 200 || s === 409), `${a.status} ${b.status}`);
  const historico = (await dev.call('GET', `/properties/${casa.id}/price-history`)).body.data.filter((h) => h.offerId === oferta.id);
  const aceitas = [a, b].filter((r) => r.status === 200).length;
  assert.equal(historico.length, 1 + aceitas, 'criação + uma linha por alteração aceita, nenhuma perdida');
  const final = Number((await dev.call('GET', `/properties/${casa.id}/offers`)).body.data.find((o) => o.id === oferta.id).askingPrice);
  historico.sort((x, y) => new Date(x.changedAt) - new Date(y.changedAt));
  const ultima = historico[historico.length - 1];
  assert.equal(Number(ultima.newPrice), final, 'o preço vigente é o da última linha do histórico');
  const corrida = historico.filter((h) => h.reasonCode === 'PRICE_UPDATE');
  if (corrida.length === 2) assert.equal(Number(corrida[1].oldPrice), Number(corrida[0].newPrice), 'a segunda alteração partiu do preço gravado pela primeira (lock, sem atualização perdida)');
});

test('CRM-TS-015 Complaint delete — Usuário tenta apagar — Bloqueado/audit', { skip: H.SKIP }, async () => {
  const { personId } = await T.pessoaDev(dev);
  const oc = await dev.call('POST', '/crm/occurrences', { personId, type: 'COMPLAINT', severity: 'HIGH', description: 'Atendimento ruim' });
  assert.equal(oc.status, 201, JSON.stringify(oc.body));
  const del = await dev.call('DELETE', `/crm/occurrences/${oc.body.data.id}`);
  assert.ok([403, 409, 422].includes(del.status), JSON.stringify(del.body));
  assert.equal((await dev.call('GET', `/crm/feedback-cases/${oc.body.data.id}`)).status, 200, 'a ocorrência continua lá');
  assert.ok(await T.count("SELECT count(*)::int AS n FROM audit.audit_log WHERE entity_id = $1 AND action IN ('feedback_case.delete_refused', 'feedback_case.delete.blocked')", [oc.body.data.id]) >= 1, 'a tentativa ficou na auditoria');
});
