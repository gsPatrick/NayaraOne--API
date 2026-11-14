'use strict';

// Verificação independente do Marco 5, linha 65 (Caderno §7 "Requirements são gerados por tipo de contrato + regras +
// características das partes/imóvel"; Guia §20 "Requirements engine integrado ao Motor de Regras"):
//  - a empresa publica nova versão da regra REG-JUR-001 por rota, com legal:approve, motivo e auditoria;
//  - a política só aceita condição sobre os fatos do catálogo e referências fechadas;
//  - característica do IMÓVEL na condição muda o checklist;
//  - a semente anterior sem alteração recebe a semente atual; política da empresa nunca é trocada.
// HTTP real com os perfis do seed de dois tenants (RLS real); cada teste devolve a política padrão no fim.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./m5fech.contratos.helpers');
const { DEFAULT_ACTION, PREVIOUS_SEED_HASHES } = require('../src/modules/legal/contracts/application/requirementRules.defaults');
const { publishRequirementRules } = require('../src/modules/legal/contracts/application/requirementRules.service');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

const clone = (x) => JSON.parse(JSON.stringify(x));
const restaurar = () => h.comTenant('A:gestor', (tx, tn) => publishRequirementRules(tn, DEFAULT_ACTION, tn.userId, tx));
const versoes = async () => (await h.http('A:leitura', 'GET', '/legal/requirement-rules/versions')).data;
const hashOf = (a) => crypto.createHash('sha256').update(JSON.stringify(a)).digest('hex');

async function gerar(contractType, extra = {}) {
  const c = await h.http('A:gestor', 'POST', '/contracts', { contractType, totalValue: 1000, ...extra });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const g = await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/requirements/generate`, {});
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return g.data.map((r) => r.requirementCode);
}

test('linha 65: publicar nova versão da REG-JUR-001 por rota — legal:approve, motivo, auditoria; a versão nova muda o checklist e a anterior é fechada', async (t) => {
  if (pular) return t.skip(pular);
  const action = clone(DEFAULT_ACTION);
  action.templates.LEASE.push({ requirementCode: 'LEASE_CONDO_RULES', requirementType: 'OBLIGATIONS', description: 'Regimento interno do condomínio.' });
  try {
    const maker = await h.http('A:maker', 'POST', '/legal/requirement-rules', { action, reason: 'Exigir o regimento do condomínio' });
    assert.equal(maker.status, 403);
    const leitura = await h.http('A:leitura', 'POST', '/legal/requirement-rules', { action, reason: 'Exigir o regimento do condomínio' });
    assert.equal(leitura.status, 403);
    const antes = await versoes();
    const pub = await h.http('A:checker', 'POST', '/legal/requirement-rules', { action, reason: 'Exigir o regimento do condomínio' });
    assert.equal(pub.status, 201, JSON.stringify(pub.body));
    const depois = await versoes();
    assert.equal(depois.length, antes.length + 1);
    assert.equal(depois[0].versionNumber, pub.data.version.versionNumber);
    assert.ok(depois.slice(1).every((v) => v.effectiveUntil), 'a versão anterior foi fechada, nunca editada');
    const vigente = await h.http('A:leitura', 'GET', '/legal/requirement-rules');
    assert.equal(vigente.data.version.id, pub.data.version.id);
    assert.ok(vigente.data.catalog.facts['property.isNew'], 'o catálogo mostra os fatos aceitos');
    const [aud] = await h.sql('A:gestor', "SELECT user_id AS actor_user_id, reason, after_json FROM audit.audit_log WHERE action = 'legal.requirement_rules.publish' AND entity_id = :id", { id: pub.data.version.id });
    assert.equal(aud.actor_user_id, h.tenantOf('A:checker').userId);
    assert.match(aud.reason, /Exigir o regimento do condomínio/);
    assert.ok((await gerar('LEASE_RESIDENTIAL')).includes('LEASE_CONDO_RULES'), 'o checklist segue a versão publicada pela empresa');
  } finally {
    await restaurar();
  }
});

test('linha 65: política inválida é recusada e nada é publicado — fato fora do catálogo, modelo inexistente, sem motivo', async (t) => {
  if (pular) return t.skip(pular);
  const antes = (await versoes()).length;
  const fatoErrado = clone(DEFAULT_ACTION);
  fatoErrado.templates.LEASE[0].when = { fact: 'imovel.novo', op: '==', value: true };
  const r1 = await h.http('A:checker', 'POST', '/legal/requirement-rules', { action: fatoErrado, reason: 'Fato digitado errado' });
  assert.equal(r1.status, 400);
  assert.equal(r1.code, 'LEGAL_REQUIREMENT_RULE_VALIDATION');
  const semModelo = clone(DEFAULT_ACTION);
  semModelo.typeToTemplate.SALE_CASH = 'NAO_EXISTE';
  assert.equal((await h.http('A:checker', 'POST', '/legal/requirement-rules', { action: semModelo, reason: 'Modelo inexistente' })).code, 'LEGAL_REQUIREMENT_RULE_VALIDATION');
  assert.equal((await h.http('A:checker', 'POST', '/legal/requirement-rules', { action: DEFAULT_ACTION })).code, 'LEGAL_REQUIREMENT_RULE_REASON_REQUIRED');
  assert.equal((await versoes()).length, antes, 'nenhuma versão nova');
});

test('linha 65: característica do imóvel na condição da regra muda o checklist (imóvel rural x residencial, configurável pela empresa)', async (t) => {
  if (pular) return t.skip(pular);
  const action = clone(DEFAULT_ACTION);
  action.templates.SALE_CASH.push({ requirementCode: 'SALE_CASH_CCIR', requirementType: 'CERTIFICATES', description: 'CCIR e ITR do imóvel rural.', when: { fact: 'property.propertyType', op: '==', value: 'RURAL' } });
  try {
    assert.equal((await h.http('A:checker', 'POST', '/legal/requirement-rules', { action, reason: 'Imóvel rural exige CCIR/ITR' })).status, 201);
    const imovel = async (propertyType) => (await h.http('A:gestor', 'POST', '/properties', { title: `Imóvel ${propertyType} ${h.sfx()}`, internalCode: `RG-${h.sfx()}`, propertyType })).data.id;
    assert.ok((await gerar('SALE_CASH', { propertyId: await imovel('RURAL') })).includes('SALE_CASH_CCIR'));
    assert.ok(!(await gerar('SALE_CASH', { propertyId: await imovel('RESIDENTIAL') })).includes('SALE_CASH_CCIR'));
  } finally {
    await restaurar();
  }
});

test('linha 65: a semente anterior sem alteração recebe a semente atual (auditada); política alterada pela empresa não é trocada', async (t) => {
  if (pular) return t.skip(pular);
  const antiga = clone(DEFAULT_ACTION);
  delete antiga.templates.KEY_DELIVERY;
  antiga.typeToTemplate.KEY_DELIVERY = 'NEW_PROPERTY_DELIVERY';
  assert.ok(PREVIOUS_SEED_HASHES.includes(hashOf(antiga)), 'a semente antiga reconstruída tem o hash registrado');
  try {
    await h.comTenant('A:gestor', (tx, tn) => publishRequirementRules(tn, antiga, tn.userId, tx));
    await gerar('LEASE_RESIDENTIAL');
    const [v] = await versoes();
    assert.equal(v.contentHash, hashOf(DEFAULT_ACTION), 'a semente intocada foi atualizada na geração seguinte');
    const [aud] = await h.sql('A:gestor', "SELECT reason FROM audit.audit_log WHERE action = 'legal.requirement_rules.publish' AND entity_id = :id", { id: v.id });
    assert.match(aud.reason, /semente atualizada/);

    const daEmpresa = clone(antiga);
    daEmpresa.templates.LEASE.push({ requirementCode: 'LEASE_EMPRESA', requirementType: 'OBLIGATIONS', description: 'Item da empresa.' });
    await h.comTenant('A:gestor', (tx, tn) => publishRequirementRules(tn, daEmpresa, tn.userId, tx));
    const total = (await versoes()).length;
    await gerar('LEASE_RESIDENTIAL');
    assert.equal((await versoes()).length, total, 'política publicada pela empresa nunca é trocada');
  } finally {
    await restaurar();
  }
});
