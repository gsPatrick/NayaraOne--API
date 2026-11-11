'use strict';
/**
 * Locação — Entrega de chaves e seus gates (Caderno M5 §10, JUR-005, JUR-TS-004, §18 keys.delivered,
 * §19 "Checklist + permissão", Guia §11/§14/§16/§19/§20). HTTP real; a assinatura da vistoria de
 * entrada exige MFA recente na rota (recusa capturada) e é feita pela camada de serviço.
 */
const { preparo, contratoLocacao, assinarContrato, arquivo, noTenant } = require('../apoio-locacao/preparo');

const RQ = {
  jur005: 'M5-A0303-33ee80', checklist: 'M5-A0079-456494', signedActive: 'M5-A0080-157e61', vistoria: 'M5-A0081-9fbe36',
  docsGarantias: 'M5-A0082-0bfb1f', qtd: 'M5-A0083-ed53e0', fotos: 'M5-A0084-c60910', termo: 'M5-A0085-d2ec3a',
  evtInicia: 'M5-A0086-fda035', evtP1: 'M5-A0136-e672e2', evtP2: 'M5-A0226-43d13b', perm: 'M5-A0145-146a2f',
  ts004: 'M5-A0152-13d5a7', dod1: 'M5-A0169-3c5062', guia: 'M5-A0205-eaae4a', api: 'M5-A0216-061071',
  semGate: 'M5-A0235-78e7ee', naoSemGate: 'M5-A0257-fbc50c', dod2: 'M5-A0269-4941b1', ts005: 'M5-A0153-4c96b0',
};
const GATE = [RQ.jur005, RQ.ts004, RQ.dod1, RQ.semGate, RQ.naoSemGate, RQ.dod2, RQ.guia];

module.exports = async function locacaoChaves(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoLocacao(R, 'LC-CH-P1', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 3200 });
  const c = {};
  const rel = () => `/legal/key-deliveries/${c.kd}/release`;
  const ok = { keysCount: 3, keysIdentification: '2 chaves da porta principal e 1 controle do portão', termSignedByPersonId: lc.locatario };
  // Fechamento M5 (Caderno §10 "Assinatura do termo de entrega"): a via do termo assinada pelo locatário vai junto.
  ok.termEvidenceFileId = await arquivo(R, 'LC-CH-P5', 'Via do termo de entrega assinada pelo locatário (arquivo fictício)', 'termo-entrega-assinado.pdf', `Termo assinado ${lc.sfx}`, 'application/pdf', [RQ.termo]);
  const apolice = (n) => arquivo(R, `LC-CH-P6${n}`, `Preparação: apólice ${n} (arquivo fictício)`, `apolice-${n}.pdf`, `Apólice ${n} ${lc.sfx}`, 'application/pdf', [RQ.docsGarantias]);
  const seguro = async (n, extra) => ({ guaranteeType: 'INSURANCE', value: 38400, providerName: 'Seguradora Fictícia', policyNumber: `CH-${n}-${lc.sfx}`, policyFileId: await apolice(n), premiumInstallments: [{ number: 1, dueDate: '2026-02-01', amount: 900 }], ...extra });

  await H({ id: 'LC-CH-01', req: [RQ.api, RQ.qtd], titulo: 'Abre a entrega de chaves do contrato (PENDING)', quem: 'A:gestor', metodo: 'POST', rota: '/legal/key-deliveries', corpo: { contractId: ct.id, deliveredToPersonId: lc.locatario }, esperado: { status: 201 }, guardar: (b) => { c.kd = b.data.id; } });
  await H({ id: 'LC-CH-02', req: ['M5-A0145-146a2f', 'M5-A0079-456494', RQ.signedActive, ...GATE], titulo: 'Chave cedo: contrato ainda em DRAFT (sem assinatura) bloqueia a entrega', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_BLOCKED' } });

  await assinarContrato(R, 'LC-CH-P2', ct.id, { locadorId: lc.locador, locatarioId: lc.locatario });
  await H({ id: 'LC-CH-P3', req: [RQ.signedActive], titulo: 'Contrato passou sozinho a SIGNED quando a última assinatura obrigatória foi registrada', quem: 'A:leitura', metodo: 'GET', rota: `/legal/contracts/${ct.id}`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (!b || !b.data || b.data.status !== 'SIGNED') passo.ok = false; } });

  await H({ id: 'LC-CH-03', req: ['M5-A0079-456494', RQ.vistoria, ...GATE], titulo: 'Contrato SIGNED sem vistoria de entrada bloqueia a entrega', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_BLOCKED' } });
  await H({ id: 'LC-CH-04', req: [RQ.vistoria], titulo: 'Vistoria de entrada (ENTRY) do contrato', quem: 'A:gestor', metodo: 'POST', rota: '/legal/inspections', corpo: { propertyId: lc.imovel, contractId: ct.id, inspectionType: 'ENTRY' }, esperado: { status: 201 }, guardar: (b) => { c.ins = b.data.id; } });
  await H({ id: 'LC-CH-05', req: [RQ.vistoria], titulo: 'Item da vistoria de entrada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${c.ins}/items`, corpo: { itemName: 'Sala — piso', condition: 'GOOD', notes: 'Piso sem marcas' }, esperado: { status: 201 } });
  await H({ id: 'LC-CH-06', req: [RQ.vistoria], titulo: 'Conclui a vistoria de entrada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${c.ins}/complete`, corpo: {}, esperado: { status: 200 } });
  await H({ id: 'LC-CH-07', req: ['M5-A0079-456494', RQ.vistoria, ...GATE], titulo: 'Vistoria concluída mas sem assinatura bloqueia a entrega', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_INSPECTION_NOT_SIGNED' } });
  await H({ id: 'LC-CH-44', req: [RQ.termo, RQ.vistoria], titulo: 'Sem a via assinada do termo a recusa diz isso antes de falar da assinatura da vistoria', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: { ...ok, termEvidenceFileId: undefined }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_TERM_EVIDENCE_REQUIRED' } });
  await H({ id: 'LC-CH-08', req: ['M5-A0215-5e9a8f', RQ.vistoria], titulo: 'Assinar a vistoria por HTTP exige MFA recente (recusado sem step-up)', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${c.ins}/sign`, corpo: { partyRole: 'LANDLORD', signaturePayload: 'aceite' }, esperado: { status: 403 } });

  const inspections = require('../../../src/modules/legal/inspections/inspection.service');
  await R.servico({ id: 'LC-CH-09', req: [RQ.vistoria], titulo: 'Locador assina a vistoria de entrada (camada de serviço)', chamada: 'inspections.service.signInspection(ins, {LANDLORD})', fn: noTenant(R, (tx, t) => inspections.signInspection(c.ins, { partyRole: 'LANDLORD', signaturePayload: 'Aceite do locador (fictício)' }, t.userId, tx)), esperado: {} });
  await H({ id: 'LC-CH-10', req: [RQ.vistoria, ...GATE], titulo: 'Só o locador assinou: falta o locatário, entrega bloqueada', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_INSPECTION_NOT_SIGNED' } });
  await R.servico({ id: 'LC-CH-11', req: [RQ.vistoria], titulo: 'Locatário assina a vistoria de entrada (camada de serviço)', chamada: 'inspections.service.signInspection(ins, {TENANT})', fn: noTenant(R, (tx, t) => inspections.signInspection(c.ins, { partyRole: 'TENANT', signaturePayload: 'Aceite do locatário (fictício)' }, t.userId, tx)), esperado: {} });

  const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await H({ id: 'LC-CH-12', req: [RQ.docsGarantias, RQ.ts005], titulo: 'Seguro-fiança cadastrado já vencido (status ainda ACTIVE)', quem: 'A:gestor', metodo: 'POST', rota: `/legal/contracts/${ct.id}/guarantees`, corpo: await seguro('A', { startsAt: '2025-01-01', endsAt: ontem, renewalDueAt: ontem, status: 'ACTIVE' }), esperado: { status: 201 }, guardar: (b) => { c.gVencida = b.data.id; } });
  await H({ id: 'LC-CH-13', req: ['M5-A0079-456494', RQ.docsGarantias, RQ.ts005, ...GATE], titulo: 'Garantia vencida bloqueia a entrega mesmo com status ACTIVE', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_GUARANTEE_INVALID' } });
  await H({ id: 'LC-CH-14', req: [RQ.docsGarantias], titulo: 'Garantia vigente (seguro-fiança renovado, com todos os dados) cadastrada', quem: 'A:gestor', metodo: 'POST', rota: `/legal/contracts/${ct.id}/guarantees`, corpo: await seguro('B', { startsAt: '2026-01-01', endsAt: '2029-12-31', renewalDueAt: '2029-11-30' }), esperado: { status: 201 }, guardar: (b, x, passo) => { if (b.data.status !== 'ACTIVE') passo.ok = false; } });

  await H({ id: 'LC-CH-15', req: [RQ.qtd, ...GATE], titulo: 'Sem quantidade de chaves/controles a entrega é recusada', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: { termSignedByPersonId: lc.locatario }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_VALIDATION' } });
  await H({ id: 'LC-CH-16', req: [RQ.termo, ...GATE], titulo: 'Sem assinatura do termo de entrega a entrega é recusada', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: { keysCount: 3 }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_VALIDATION' } });
  await H({ id: 'LC-CH-17', req: [RQ.termo], titulo: 'Termo assinado por quem não é parte do contrato é recusado', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: { ...ok, termSignedByPersonId: lc.fiador }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_TERM_SIGNER_INVALID' } });
  await H({ id: 'LC-CH-18', req: [RQ.fotos], titulo: 'Cliente não pode desligar a política de fotos', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: { ...ok, photosRequired: false }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_SERVER_POLICY' } });
  await H({ id: 'LC-CH-19', req: [RQ.perm, RQ.guia], titulo: 'Leitura (sem lease.keys.deliver) não entrega chaves', quem: 'A:leitura', metodo: 'POST', rota: rel, corpo: { ...ok, termEvidenceFileId: undefined }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-CH-20', req: ['M5-A0205-eaae4a', RQ.perm], titulo: 'Maker (sem lease.keys.deliver) não entrega chaves', quem: 'A:maker', metodo: 'POST', rota: rel, corpo: { ...ok, termEvidenceFileId: undefined }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-CH-21', req: [RQ.perm], titulo: 'Tenant B não entrega as chaves do contrato do tenant A', quem: 'B:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 404 } });
  await H({ id: 'LC-CH-22', req: [RQ.termo, RQ.qtd], titulo: 'Prévia do termo gerado pelo servidor', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/key-deliveries/${c.kd}/term-preview?keysCount=3&keysIdentification=2%20chaves%20e%201%20controle&termSignedByPersonId=${lc.locatario}`, esperado: { status: 200 } });
  // ---------- checklist da etapa KEY_DELIVERY (Motor de Regras) e via assinada do termo ----------
  const { ContractRequirement } = require('../../../src/models');
  await R.servico({ id: 'LC-CH-38', req: ['M5-A0079-456494', RQ.docsGarantias, RQ.jur005, RQ.guia], titulo: 'Preparação: o checklist do contrato ganha uma exigência da etapa KEY_DELIVERY ainda pendente (comprovante das chaves)', chamada: 'ContractRequirement.create({ requiredStage: KEY_DELIVERY, status: PENDING })', fn: noTenant(R, async (tx, t) => { const r = await ContractRequirement.create({ groupId: t.groupId, companyId: t.companyId, contractId: ct.id, requirementCode: `LEASE_KEYS_${lc.sfx}`, requirementType: 'KEYS', description: 'Relação das chaves e controles conferida', status: 'PENDING', requiredStage: 'KEY_DELIVERY', createdBy: t.userId }, { transaction: tx }); c.reqChaves = r.id; return { id: r.id }; }), esperado: {} });
  await H({ id: 'LC-CH-39', req: ['M5-A0079-456494', RQ.docsGarantias, RQ.jur005, RQ.guia, ...GATE], titulo: 'Exigência da etapa KEY_DELIVERY pendente bloqueia a entrega (checklist reconferido na hora)', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_REQUIREMENTS_PENDING' } });
  const relacao = await arquivo(R, 'LC-CH-P7', 'Relação das chaves conferida (arquivo fictício)', 'relacao-chaves.pdf', `Relação ${lc.sfx}`, 'application/pdf', [RQ.docsGarantias]);
  await H({ id: 'LC-CH-40', req: ['M5-A0079-456494', RQ.docsGarantias], titulo: 'Exigência satisfeita com o documento', quem: 'A:gestor', metodo: 'PATCH', rota: () => `/legal/requirements/${c.reqChaves}`, corpo: { satisfiedByFileId: relacao }, esperado: { status: 200 } });
  await H({ id: 'LC-CH-41', req: ['M5-A0303-33ee80', RQ.termo], titulo: 'Sem a via assinada do termo de entrega a entrega é recusada', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: { ...ok, termEvidenceFileId: undefined }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_TERM_EVIDENCE_REQUIRED' } });
  await H({ id: 'LC-CH-23', req: ['M5-A0226-43d13b', 'M5-A0136-e672e2', 'M5-A0079-456494', RQ.signedActive, RQ.vistoria, RQ.docsGarantias, RQ.qtd, RQ.fotos, RQ.termo, RQ.evtInicia, RQ.perm, ...GATE], titulo: 'Com contrato SIGNED, vistoria de entrada assinada pelas duas partes, garantia vigente, quantidade/identificação e termo assinado: chaves entregues', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 200 } });
  await H({ id: 'LC-CH-42', req: [RQ.termo], titulo: 'A via assinada do termo tem dono: leitura (legal:read) consulta o arquivo; tenant B não', quem: 'A:leitura', metodo: 'GET', rota: `/files/${ok.termEvidenceFileId}`, esperado: { status: 200 } });
  await H({ id: 'LC-CH-43', req: [RQ.termo], titulo: 'Tenant B não enxerga a via assinada do termo', quem: 'B:gestor', metodo: 'GET', rota: `/files/${ok.termEvidenceFileId}`, esperado: { status: 404 } });
  await H({ id: 'LC-CH-24', req: ['M5-A0269-4941b1', RQ.ts004], titulo: 'Entregar de novo a mesma entrega é recusado', quem: 'A:gestor', metodo: 'POST', rota: rel, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_ALREADY_RELEASED' } });
  await R.sqlTenant({
    id: 'LC-CH-25', req: [RQ.qtd, RQ.termo, RQ.fotos], quem: 'A:leitura', descricao: 'Entrega gravada: quantidade, identificação, quem assinou o termo, quando, hash do termo e política de fotos do servidor',
    sql: 'SELECT id, status, keys_count, keys_identification, term_signed_by_person_id, term_signed_at, term_version, term_hash, term_evidence_file_id, term_evidence_sha256, term_signature_method, photo_policy, photos_required, delivered_at FROM legal.key_deliveries WHERE id = :id',
    replacements: () => ({ id: c.kd }), avaliar: (rows) => rows.length === 1 && rows[0].status === 'RELEASED' && rows[0].keys_count === 3 && /^[0-9a-f]{64}$/.test(rows[0].term_hash) && rows[0].term_signed_by_person_id === lc.locatario && rows[0].term_evidence_file_id === ok.termEvidenceFileId && /^[0-9a-f]{64}$/.test(rows[0].term_evidence_sha256) && rows[0].term_signature_method === 'MANUAL_EVIDENCE',
  });
  await R.sqlTenant({
    id: 'LC-CH-26', req: [RQ.evtInicia, RQ.evtP1, RQ.evtP2, RQ.guia], quem: 'A:gestor', descricao: 'Outbox: keys.delivered publicado na mesma transação da entrega (uma vez, com chave de idempotência)',
    sql: "SELECT event_type, idempotency_key, payload_json FROM integration.outbox_events WHERE aggregate_id = :id AND event_type IN ('keys.delivered','legal.key_delivery.released') ORDER BY event_type",
    replacements: () => ({ id: c.kd }), avaliar: (rows) => rows.filter((r) => r.event_type === 'keys.delivered').length === 1,
  });

  // ---------- política de fotos (imóvel usado) ----------
  await H({ id: 'LC-CH-27', req: [RQ.fotos], titulo: 'Entrega de imóvel usado (termo específico)', quem: 'A:gestor', metodo: 'POST', rota: '/legal/key-deliveries', corpo: { contractId: ct.id, deliveredToPersonId: lc.locatario, termType: 'USED_PROPERTY_DELIVERY' }, esperado: { status: 201 }, guardar: (b) => { c.kd2 = b.data.id; } });
  await H({ id: 'LC-CH-28', req: [RQ.fotos, ...GATE], titulo: 'Imóvel usado sem fotos: a política do servidor exige fotos e bloqueia', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/key-deliveries/${c.kd2}/release`, corpo: ok, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_PHOTOS_REQUIRED' } });
  await H({ id: 'LC-CH-29', req: [RQ.fotos], titulo: 'Imóvel usado com id de foto inventado (arquivo inexistente) é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/key-deliveries/${c.kd2}/release`, corpo: { ...ok, photosFileIds: ['11111111-1111-4111-8111-111111111111'] }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_PHOTO_INVALID' } });
  const foto = await arquivo(R, 'LC-CH-30', 'Foto do imóvel usado (imagem fictícia)', 'sala.png', `PNG fictício ${ct.id}`, 'image/png', [RQ.fotos]);
  await H({ id: 'LC-CH-31', req: [RQ.fotos], titulo: 'Imóvel usado com foto real enviada: entrega liberada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/key-deliveries/${c.kd2}/release`, corpo: { ...ok, photosFileIds: [foto] }, esperado: { status: 200 } });
  await H({ id: 'LC-CH-32', req: [RQ.termo], titulo: 'Recebedor que não é parte do contrato é recusado já na abertura', quem: 'A:gestor', metodo: 'POST', rota: '/legal/key-deliveries', corpo: { contractId: ct.id, deliveredToPersonId: lc.fiador }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_RECIPIENT_NOT_PARTY' } });

  // ---------- rota do Guia §14: POST /contracts/:id/key-delivery (abre e libera numa transação) ----------
  const rascunho = await contratoLocacao(R, 'LC-CH-P4', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 3100 });
  const alias = (id) => `/contracts/${id}/key-delivery`;
  const aliasLegal = (id) => `/legal/contracts/${id}/key-delivery`;
  await H({ id: 'LC-CH-33', req: [RQ.api, RQ.signedActive, ...GATE], titulo: 'POST /contracts/:id/key-delivery (rota literal do Guia §14) com contrato em DRAFT: bloqueado pelo mesmo gate', quem: 'A:gestor', metodo: 'POST', rota: alias(rascunho.id), corpo: { deliveredToPersonId: lc.locatario, ...ok }, esperado: { status: 409, codigo: 'LEGAL_KEY_DELIVERY_BLOCKED' } });
  await R.sqlTenant({ id: 'LC-CH-34', req: [RQ.api, RQ.guia], quem: 'A:leitura', descricao: 'Entrega recusada pela rota do Guia não deixa nenhuma entrega gravada (mesma transação)', sql: 'SELECT count(*)::int AS entregas FROM legal.key_deliveries WHERE contract_id = :c', replacements: () => ({ c: rascunho.id }), avaliar: (rows) => rows[0].entregas === 0 });
  await H({ id: 'LC-CH-35', req: ['M5-A0205-eaae4a', RQ.api, RQ.perm], titulo: 'Maker (sem lease.keys.deliver) não usa POST /legal/contracts/:id/key-delivery', quem: 'A:maker', metodo: 'POST', rota: aliasLegal(ct.id), corpo: { deliveredToPersonId: lc.locatario, ...ok, termEvidenceFileId: undefined }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-CH-36', req: ['M5-A0205-eaae4a', RQ.api, RQ.signedActive, RQ.vistoria, RQ.docsGarantias, RQ.qtd, RQ.termo, RQ.evtInicia], titulo: 'POST /contracts/:id/key-delivery (rota literal do Guia §14) com todos os gates cumpridos: chaves entregues (RELEASED)', quem: 'A:gestor', metodo: 'POST', rota: alias(ct.id), corpo: { deliveredToPersonId: lc.locatario, ...ok }, esperado: { status: 201 }, guardar: (b, x, passo) => { if (!b.data || b.data.status !== 'RELEASED' || !b.data.termHash) passo.ok = false; } });

  await H({ id: 'LC-CH-45', req: [RQ.api], titulo: 'Pentest: objeto no lugar do id do contrato na abertura da entrega é 400, não 500', quem: 'A:gestor', metodo: 'POST', rota: '/legal/key-deliveries', corpo: { contractId: { $gt: '' }, deliveredToPersonId: lc.locatario }, esperado: { status: 400, codigo: 'LEGAL_KEY_DELIVERY_VALIDATION' } });
  R.ctx.lcChaves = { contrato: ct.id, ...c };
};
