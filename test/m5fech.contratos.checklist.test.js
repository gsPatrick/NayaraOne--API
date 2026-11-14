'use strict';

// Matriz de fechamento do Marco 5 (Contratos) — Caderno §7 "Checklist documental": o conteúdo de cada fluxo
// do livro gerado pela rota real, e o gate (JUR-003/JUR-TS-003) por HTTP. Dois tenants do seed de CI.
process.env.PORT = process.env.M5FECH_CT_PORT || '5534';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./m5fech.contratos.helpers');

let pular = null;
before(async () => { pular = await h.pronto(); });
after(h.encerrar);

async function gerar(contractType, corpo = {}, partes = []) {
  const c = await h.http('A:gestor', 'POST', '/legal/contracts', { contractType, totalValue: 1000 });
  assert.equal(c.status, 201);
  for (const parte of partes) assert.equal((await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/parties`, parte)).status, 201);
  const g = await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/requirements/generate`, corpo);
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return { contractId: c.data.id, itens: g.data.map((r) => [r.requirementCode, r.requirementType, r.status]) };
}

test('§7 Locação: documentos PF/PJ, garantia, procuração só se aplicável, vistoria, titularidade e obrigações', async (t) => {
  if (pular) return t.skip(pular);
  const sem = await gerar('LEASE_COMMERCIAL');
  // Fechamento M5 (M5-A0079, DI-M5VP-2): + KEYS, a exigência da etapa KEY_DELIVERY (relação das chaves e controles).
  assert.deepEqual(sem.itens.map((i) => i[1]), ['PF_DOCUMENT', 'GUARANTEE', 'INSPECTION', 'OWNERSHIP_PROOF', 'OBLIGATIONS', 'KEYS']);
  assert.ok(sem.itens.every((i) => i[2] === 'PENDING'));
  const locador = await h.pessoa('A:gestor', 'Locador Representado');
  const procurador = await h.pessoa('A:gestor', 'Procurador');
  const com = await gerar('LEASE_RESIDENTIAL', {}, [{ personId: locador, partyRole: 'LANDLORD', representedByPersonId: procurador }]);
  assert.ok(com.itens.some((i) => i[1] === 'POWER_OF_ATTORNEY'), 'procuração entra quando a parte cadastrada é representada por procurador');
  const corpoNaoDecide = await gerar('LEASE_RESIDENTIAL', { hasRepresentedParty: true });
  assert.ok(!corpoNaoDecide.itens.some((i) => i[1] === 'POWER_OF_ATTORNEY'), 'a característica vem do cadastro da parte, não do corpo da requisição');
});

test('§7 Venda financiada: documentos de comprador e vendedor, matrícula, certidões, financiamento e dados de pagamento', async (t) => {
  if (pular) return t.skip(pular);
  const { itens } = await gerar('SALE_FINANCED');
  assert.deepEqual(itens.map((i) => i[1]), ['BUYER_DOCUMENT', 'SELLER_DOCUMENT', 'PROPERTY_REGISTRATION', 'CERTIFICATES', 'FINANCING', 'PAYMENT_DATA']);
});

test('§7 Entrega de casa nova e imóvel usado: termo, vistoria final, manual do proprietário, fotos, chaves; termo específico do usado', async (t) => {
  if (pular) return t.skip(pular);
  // Verificação M5 linha 65: o modelo vem da regra pelo tipo do contrato (KEY_DELIVERY) e a característica do imóvel decide
  // o fluxo — imóvel que nasceu de obra da empresa é casa nova; sem obra, é usado. O corpo não escolhe o modelo.
  const principal = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'SALE_CASH', totalValue: 1000 });
  const termo = async (comObra) => {
    const im = await h.http('A:gestor', 'POST', '/properties', { title: `Imóvel ${comObra ? 'novo' : 'usado'} ${h.sfx()}`, internalCode: `CK-${h.sfx()}`, propertyType: 'RESIDENTIAL' });
    if (comObra) {
      await h.comTenant('A:gestor', (tx, tn) => require('../src/models').Project.create({ groupId: tn.groupId, companyId: tn.companyId, name: `Obra ${h.sfx()}`, propertyId: im.data.id, createdBy: tn.userId }, { transaction: tx }));
    }
    const c = await h.http('A:gestor', 'POST', '/contracts', { contractType: 'KEY_DELIVERY', parentContractId: principal.data.id, propertyId: im.data.id });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const g = await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/requirements/generate`, {});
    assert.equal(g.status, 201, JSON.stringify(g.body));
    return { id: c.data.id, itens: g.data.map((r) => [r.requirementCode, r.requirementType]) };
  };
  const nova = await termo(true);
  assert.deepEqual(nova.itens.map((i) => i[1]), ['DELIVERY_TERM', 'FINAL_INSPECTION', 'OWNER_MANUAL', 'PHOTOS', 'KEYS']);
  const usado = await termo(false);
  assert.deepEqual(usado.itens.map((i) => i[0]), ['USED_PROPERTY_TERM']);
  const corpo = await h.http('A:gestor', 'POST', `/legal/contracts/${usado.id}/requirements/generate`, { templateKey: 'NEW_PROPERTY_DELIVERY' });
  assert.equal(corpo.status, 400);
  assert.equal(corpo.code, 'LEGAL_REQUIREMENT_TEMPLATE_KEY_NOT_ACCEPTED');
});

test('JUR-003/JUR-TS-003: com exigência obrigatória pendente o contrato não avança por HTTP; com a exigência satisfeita por arquivo real, avança', async (t) => {
  if (pular) return t.skip(pular);
  const c = await h.http('A:gestor', 'POST', '/legal/contracts', { contractType: 'SALE_CASH', totalValue: 1000 });
  const seller = await h.pessoa('A:gestor', 'Vendedor Fictício');
  const buyer = await h.pessoa('A:gestor', 'Comprador Fictício');
  await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/parties`, { personId: seller, partyRole: 'SELLER' });
  await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/parties`, { personId: buyer, partyRole: 'BUYER' });
  assert.equal((await h.http('A:gestor', 'POST', `/legal/contracts/${c.data.id}/requirements/generate`, {})).status, 201);
  const faltam = await h.http('A:checker', 'POST', `/legal/contracts/${c.data.id}/transition`, { targetStatus: 'DOCUMENTS_PENDING' });
  assert.equal(faltam.status, 200, 'DOCUMENTS_PENDING ("Faltam documentos") é o estado em que se fica com documento faltando');
  const bloqueado = await h.http('A:checker', 'POST', `/legal/contracts/${c.data.id}/transition`, { targetStatus: 'LEGAL_REVIEW' });
  assert.equal(bloqueado.status, 409);
  assert.equal(bloqueado.code, 'LEGAL_REQUIREMENTS_PENDING');
  assert.ok(bloqueado.body.error.details.pending.length >= 5, 'a recusa lista os códigos que faltam');
  const [ev] = await h.eventos('A:gestor', c.data.id, 'contract.requirement.missing');
  assert.ok(ev && ev.payload_json.missingRequirementCodes.length >= 5, 'contract.requirement.missing com os códigos faltantes');
  const reqs = (await h.http('A:gestor', 'GET', `/legal/contracts/${c.data.id}/requirements`)).data;
  const f = await h.arquivo('A:gestor');
  const inexistente = await h.http('A:gestor', 'PATCH', `/legal/requirements/${reqs[0].id}`, { satisfiedByFileId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(inexistente.code, 'LEGAL_REQUIREMENT_FILE_NOT_FOUND', 'documento inexistente não satisfaz exigência');
  for (const r of reqs) assert.equal((await h.http('A:gestor', 'PATCH', `/legal/requirements/${r.id}`, { satisfiedByFileId: f })).status, 200);
  const ok = await h.http('A:checker', 'POST', `/legal/contracts/${c.data.id}/transition`, { targetStatus: 'LEGAL_REVIEW' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});
