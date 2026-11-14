'use strict';
/**
 * Preparação compartilhada dos módulos de Locação (20-locacao-*.js) da captura do Marco 5.
 *
 * Não é módulo de captura (fica fora de modulos/): cada módulo chama `preparo(R)` e recebe as
 * pessoas, o imóvel e o contrato de locação do tenant A criados por HTTP real (perfil A:gestor).
 * `ativarContrato` leva um contrato de locação de DRAFT até ACTIVE só por HTTP, pela máquina de
 * estados de verdade: checklist gerado e dispensado com motivo (legal:waive), versão com
 * documento criada antes da aprovação (a aprovação do contrato aprova a versão vigente), assinatura manual de locador e locatário com a via assinada (evidência) e as
 * transições SIGNING -> SIGNED -> ACTIVE com os gates reais.
 */
const REQ_PREP = ['M5-A0080-157e61'];

function sufixo() {
  return String(Date.now()).slice(-7);
}

async function arquivo(R, id, titulo, nome, conteudo, mimeType = 'application/pdf', req = REQ_PREP) {
  let fileId = null;
  await R.http({
    id, req, titulo, quem: 'A:gestor', metodo: 'POST', rota: '/files',
    corpo: { fileName: nome, mimeType, contentBase64: Buffer.from(conteudo).toString('base64'), category: 'generic' },
    esperado: { status: 201 }, guardar: (b) => { fileId = b && b.data ? b.data.id : null; },
  });
  return fileId;
}

/** Cria um contrato de locação com locador e locatário (DRAFT). Devolve { id }. */
async function contratoLocacao(R, prefixo, { propertyId, locadorId, locatarioId, valor = 2500, req = REQ_PREP }) {
  const out = {};
  await R.http({
    id: `${prefixo}-1`, req, titulo: 'Preparação: contrato de locação residencial (DRAFT)', quem: 'A:gestor', metodo: 'POST',
    rota: '/legal/contracts', corpo: { contractType: 'LEASE_RESIDENTIAL', totalValue: valor, propertyId, startsAt: '2026-01-01', endsAt: '2028-12-31' },
    esperado: { status: 201 }, guardar: (b) => { out.id = b.data.id; },
  });
  await R.http({
    id: `${prefixo}-2`, req, titulo: 'Preparação: locador como parte do contrato', quem: 'A:gestor', metodo: 'POST',
    rota: `/legal/contracts/${out.id}/parties`, corpo: { personId: locadorId, partyRole: 'LANDLORD' }, esperado: { status: 201 },
  });
  await R.http({
    id: `${prefixo}-3`, req, titulo: 'Preparação: locatário como parte do contrato', quem: 'A:gestor', metodo: 'POST',
    rota: `/legal/contracts/${out.id}/parties`, corpo: { personId: locatarioId, partyRole: 'TENANT' }, esperado: { status: 201 },
  });
  return out;
}

/**
 * Leva o contrato até `ate` ('SIGNED' ou 'ACTIVE') só por HTTP. Antes de ACTIVE o chamador pode
 * cadastrar garantias (o gate de ativação as reconfere).
 */
async function assinarContrato(R, prefixo, contractId, { locadorId, locatarioId, req = REQ_PREP }) {
  const ids = [];
  await R.http({
    id: `${prefixo}-a`, req, titulo: 'Preparação: gera o checklist documental do contrato', quem: 'A:gestor', metodo: 'POST',
    rota: `/legal/contracts/${contractId}/requirements/generate`, corpo: {}, esperado: { status: 201 },
    guardar: (b) => { for (const r of (b && b.data) || []) ids.push(r.id); },
  });
  let n = 0;
  for (const reqId of ids) {
    n += 1;
    await R.http({
      id: `${prefixo}-b${n}`, req, titulo: 'Preparação: dispensa com motivo do item do checklist (legal:waive)', quem: 'A:gestor', metodo: 'POST',
      rota: `/legal/requirements/${reqId}/waive`, corpo: { reason: 'Dispensa de preparação da captura do fechamento do Marco 5 (documentos fictícios).' },
      esperado: { status: 200 },
    });
  }
  const docId = await arquivo(R, `${prefixo}-f1`, 'Preparação: envia o documento do contrato (arquivo fictício)', 'contrato-locacao.pdf', `Contrato de locação fictício ${contractId}`);
  let versaoId = null;
  await R.http({
    id: `${prefixo}-v`, req, titulo: 'Preparação: versão do contrato com documento e hash', quem: 'A:gestor', metodo: 'POST',
    rota: `/legal/contracts/${contractId}/versions`, corpo: { content: `Texto integral do contrato de locação fictício ${contractId}`, documentFileId: docId },
    esperado: { status: 201 }, guardar: (b) => { versaoId = b.data.id; },
  });
  for (const alvo of ['DOCUMENTS_PENDING', 'LEGAL_REVIEW', 'APPROVED']) {
    await R.http({
      id: `${prefixo}-t${alvo}`, req, titulo: `Preparação: contrato avança para ${alvo}`, quem: 'A:checker', metodo: 'POST',
      rota: `/legal/contracts/${contractId}/transition`, corpo: { targetStatus: alvo }, esperado: { status: 200 },
    });
  }
  await R.http({
    id: `${prefixo}-tSIGNING`, req, titulo: 'Preparação: contrato vai para assinatura (SIGNING)', quem: 'A:checker', metodo: 'POST',
    rota: `/legal/contracts/${contractId}/transition`, corpo: { targetStatus: 'SIGNING' }, esperado: { status: 200 },
  });
  for (const [rotulo, personId] of [['locador', locadorId], ['locatário', locatarioId]]) {
    const via = await arquivo(R, `${prefixo}-f${rotulo === 'locador' ? 2 : 3}`, `Preparação: via assinada pelo ${rotulo} (arquivo fictício)`, `via-${rotulo}.pdf`, `Via assinada ${rotulo} ${contractId}`);
    await R.http({
      id: `${prefixo}-s${rotulo === 'locador' ? 1 : 2}`, req, titulo: `Preparação: assinatura manual do ${rotulo} com a via assinada`, quem: 'A:gestor', metodo: 'POST',
      rota: `/legal/contract-versions/${versaoId}/manual-signatures`, corpo: { personId, evidenceFileId: via }, esperado: { status: 201 },
    });
  }
  return { versaoId };
}

async function transicao(R, id, contractId, alvo, { req = REQ_PREP, esperado = { status: 200 }, titulo } = {}) {
  return R.http({
    id, req, titulo: titulo || `Preparação: contrato avança para ${alvo}`, quem: 'A:checker', metodo: 'POST',
    rota: `/legal/contracts/${contractId}/transition`, corpo: { targetStatus: alvo }, esperado,
  });
}

/** Pessoas e imóvel do tenant A, criados uma única vez por captura. */
async function preparo(R) {
  if (R.ctx.lc) return R.ctx.lc;
  const sfx = sufixo();
  const lc = { sfx };
  const pessoa = async (id, rotulo, chave) => R.http({
    id, req: REQ_PREP, titulo: `Preparação: ${rotulo} fictício`, quem: 'A:gestor', metodo: 'POST', rota: '/people',
    corpo: { personType: 'PF', legalName: `${rotulo} Fictício Locação ${sfx}` }, esperado: { status: 201 }, guardar: (b) => { lc[chave] = b.data.id; },
  });
  await pessoa('LC-PREP-01', 'Locador', 'locador');
  await pessoa('LC-PREP-02', 'Locatário', 'locatario');
  await pessoa('LC-PREP-03', 'Fiador', 'fiador');
  await R.http({
    id: 'LC-PREP-04', req: REQ_PREP, titulo: 'Preparação: imóvel fictício da locação', quem: 'A:gestor', metodo: 'POST', rota: '/properties',
    corpo: { title: `Apartamento Fictício Locação ${sfx}`, internalCode: `LOC-${sfx}`, propertyType: 'RESIDENTIAL' }, esperado: { status: 201 },
    guardar: (b) => { lc.imovel = b.data.id; },
  });
  R.ctx.lc = lc;
  return lc;
}

/** Roda uma função de serviço no tenant A (perfil gestor), com commit. */
function noTenant(R, fn, quem = 'A:gestor') {
  return () => R.comTenant(quem, (tx, t) => fn(tx, t));
}

module.exports = { preparo, contratoLocacao, assinarContrato, transicao, arquivo, noTenant, sufixo, REQ_PREP };
