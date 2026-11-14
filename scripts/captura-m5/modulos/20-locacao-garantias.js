'use strict';
/**
 * Locação — Garantias locatícias (Caderno M5 §9, JUR-006, JUR-TS-005, JUR-TS-015, Guia §14/§19/§20).
 * HTTP real com os perfis do seed de dois tenants; o job de vencimento e a configuração dos fluxos homologados
 * (parâmetro da empresa) pela camada de serviço; o recebimento da caução é preparado direto no Financeiro.
 */
const { preparo, contratoLocacao, arquivo, noTenant } = require('../apoio-locacao/preparo');

const RQ = {
  jur006: 'M5-A0304-d26817', guarantor: 'M5-A0074-471be7', insurance: 'M5-A0317-07bf3b', deposit: 'M5-A0318-3e6287',
  capitalization: 'M5-A0077-365a20', other: 'M5-A0319-4269fc', vencendo: 'M5-A0320-0f6afb', evtExpP1: 'M5-A0133-78c3ee',
  evtExpP2: 'M5-A0227-21656d', ts005: 'M5-A0153-4c96b0', ts015: 'M5-A0163-9b1694', dod1: 'M5-A0168-e76ea6',
  dod2: 'M5-A0267-ce66c5', api: 'M5-A0213-3cfd1e', naoDuplicar: 'M5-A0261-d6fe86',
};

module.exports = async function locacaoGarantias(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoLocacao(R, 'LC-GA-P1', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario });
  const rota = `/legal/contracts/${ct.id}/guarantees`;
  const g = {};
  const guarda = (k, statusEsperado, tipo) => (b, x, passo) => { if (b && b.data) g[k] = b.data.id; if (b && b.data && ((statusEsperado && b.data.status !== statusEsperado) || (tipo && b.data.guaranteeType !== tipo))) passo.ok = false; };
  const f = async (id, nome) => arquivo(R, id, `Preparação: ${nome} (arquivo fictício)`, `${nome.replace(/\s+/g, '-')}.pdf`, `${nome} ${lc.sfx}`, 'application/pdf', [RQ.jur006]);

  // ---------- GUARANTOR: pessoas, documentos, vigência, aceite ----------
  await H({ id: 'LC-GA-01', req: [RQ.guarantor, RQ.api], titulo: 'Fiador sem a pessoa fiadora é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'GUARANTOR', startsAt: '2026-01-01', endsAt: '2028-12-31' }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  await H({ id: 'LC-GA-02', req: [RQ.guarantor, RQ.jur006, RQ.dod2], titulo: 'Fiador sem fim de vigência é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'GUARANTOR', guarantorPersonId: lc.fiador, startsAt: '2026-01-01' }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDITY_REQUIRED' } });
  await H({ id: 'LC-GA-31', req: [RQ.guarantor], titulo: 'O locatário não pode ser o fiador do próprio contrato', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'GUARANTOR', guarantorPersonId: lc.locatario, endsAt: '2028-12-31' }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_GUARANTOR_CONFLICT' } });
  await H({ id: 'LC-GA-32', req: [RQ.guarantor, RQ.jur006], titulo: 'Fiador sem documentos e sem aceite nasce PENDING (não vale como garantia ativa)', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'GUARANTOR', guarantorPersonId: lc.fiador, startsAt: '2026-01-01', endsAt: '2028-12-31' }, esperado: { status: 201 }, guardar: guarda('fiadorPendente', 'PENDING') });
  const docFiador = await f('LC-GA-P2', 'documentos do fiador');
  const aceite = await f('LC-GA-P3', 'termo de aceite do fiador');
  await H({ id: 'LC-GA-03', req: [RQ.guarantor, RQ.jur006, RQ.api, RQ.dod1, RQ.dod2], titulo: 'Fiador com pessoa, documentos, vigência e termo de aceite: ACTIVE', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'GUARANTOR', guarantorPersonId: lc.fiador, startsAt: '2026-01-01', endsAt: '2028-12-31', documentFileIds: [docFiador], acceptanceFileId: aceite, acceptedAt: '2026-01-02' }, esperado: { status: 201 }, guardar: guarda('fiador', 'ACTIVE') });

  // ---------- INSURANCE: provider/apólice, vigência, parcelas, renovação ----------
  await H({ id: 'LC-GA-04', req: [RQ.insurance, RQ.jur006], titulo: 'Seguro-fiança sem fim de vigência é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'INSURANCE', value: 30000, startsAt: '2026-01-01' }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDITY_REQUIRED' } });
  await H({ id: 'LC-GA-33', req: [RQ.insurance], titulo: 'Seguro-fiança ACTIVE sem seguradora, apólice, parcelas e renovação é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'INSURANCE', value: 30000, endsAt: '2027-01-01', status: 'ACTIVE' }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  const apolice = await f('LC-GA-P4', 'apolice do seguro');
  const seguro = { guaranteeType: 'INSURANCE', value: 30000, startsAt: '2026-01-01', endsAt: '2027-01-01', providerName: 'Seguradora Fictícia', policyNumber: `AP-${lc.sfx}`, policyFileId: apolice, annualPremium: 2400, premiumInstallments: [{ number: 1, dueDate: '2026-02-01', amount: 1200 }, { number: 2, dueDate: '2026-08-01', amount: 1200 }], renewalDueAt: '2026-12-01', autoRenew: true };
  await H({ id: 'LC-GA-05', req: [RQ.insurance, RQ.jur006, RQ.api], titulo: 'Seguro-fiança com seguradora, apólice (arquivo), vigência, 2 parcelas e renovação: gravado e ACTIVE', quem: 'A:gestor', metodo: 'POST', rota, corpo: seguro, esperado: { status: 201 }, guardar: guarda('seguro', 'ACTIVE') });
  await H({ id: 'LC-GA-42', req: [RQ.insurance, RQ.guarantor], titulo: 'Arquivo da apólice tem dono: leitura (legal:read) consulta o arquivo', quem: 'A:leitura', metodo: 'GET', rota: `/files/${apolice}`, esperado: { status: 200 } });
  await H({ id: 'LC-GA-43', req: [RQ.insurance, RQ.guarantor], titulo: 'Termo de aceite do fiador: tenant B não enxerga o arquivo', quem: 'B:gestor', metodo: 'GET', rota: `/files/${aceite}`, esperado: { status: 404 } });
  await H({ id: 'LC-GA-34', req: [RQ.insurance], titulo: 'Mesma apólice da mesma seguradora em outra garantia é recusada', quem: 'A:gestor', metodo: 'POST', rota, corpo: { ...seguro, policyFileId: undefined }, esperado: { status: 409, codigo: 'LEGAL_GUARANTEE_POLICY_DUPLICATE' } });

  // ---------- SECURITY_DEPOSIT: valor de terceiro, vínculo financeiro, devolução/compensação ----------
  const { FinancialEntry, ContractParty } = require('../../../src/models');
  await R.servico({
    id: 'LC-GA-P5', req: [RQ.deposit, RQ.ts015], titulo: 'Preparação no Financeiro: recebimento da caução (dinheiro de terceiro, R$ 7.500,00, titular o locatário) e uma devolução parcial de R$ 2.500,00',
    chamada: 'FinancialEntry.create (recebimento de terceiros + devolução ligada à origem)',
    fn: noTenant(R, async (tx, t) => {
      const party = await ContractParty.findOne({ where: { contractId: ct.id, partyRole: 'TENANT' }, transaction: tx });
      const base = { groupId: t.groupId, companyId: t.companyId, contractId: ct.id, isThirdPartyFunds: true, thirdPartyReference: `Caução contrato ${ct.id}`, thirdPartyHolderPersonId: party.personId, createdBy: t.userId };
      const origin = await FinancialEntry.create({ ...base, entryType: 'RECEIVABLE', nature: 'RECEIVABLE', amount: 7500, status: 'SETTLED', description: 'Recebimento da caução (fictício)' }, { transaction: tx });
      await FinancialEntry.create({ ...base, entryType: 'PAYABLE', nature: 'PAYABLE', amount: 2500, status: 'PENDING', description: 'Devolução parcial da caução (fictício)', thirdPartyOriginEntryId: origin.id }, { transaction: tx });
      g.origem = origin.id;
      return { originEntryId: origin.id };
    }),
    esperado: {},
  });
  await H({ id: 'LC-GA-06', req: [RQ.deposit], titulo: 'Caução com o código do livro SECURITY_DEPOSIT sem o recebimento no Financeiro: aceita, mas PENDING', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 7500 }, esperado: { status: 201 }, guardar: guarda('caucaoPendente', 'PENDING', 'SECURITY_DEPOSIT') });
  await H({ id: 'LC-GA-35', req: [RQ.deposit, RQ.naoDuplicar], titulo: 'Caução apontando para lançamento inexistente é recusada', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 7500, financeEntryId: '00000000-0000-4000-8000-000000000002' }, esperado: { status: 409, codigo: 'LEGAL_GUARANTEE_DEPOSIT_ORIGIN_INVALID' } });
  await H({ id: 'LC-GA-36', req: [RQ.deposit, RQ.naoDuplicar], titulo: 'Saldo da caução enviado ao jurídico é recusado (o saldo é do Financeiro)', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 7500, balance: 7500 }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_DEPOSIT_FIELD_NOT_ALLOWED' } });
  await H({ id: 'LC-GA-07', req: [RQ.deposit, RQ.jur006, RQ.naoDuplicar, RQ.ts015], titulo: 'Caução pelo apelido antigo DEPOSIT ligada ao recebimento do Financeiro: gravada como SECURITY_DEPOSIT, ACTIVE, titular do lançamento', quem: 'A:gestor', metodo: 'POST', rota, corpo: () => ({ guaranteeType: 'DEPOSIT', value: 7500, startsAt: '2026-01-01', financeEntryId: g.origem }), esperado: { status: 201 }, guardar: guarda('caucao', 'ACTIVE', 'SECURITY_DEPOSIT') });
  await H({ id: 'LC-GA-30', req: [RQ.deposit, RQ.ts015, RQ.naoDuplicar], titulo: 'Leitura da caução com a trilha do Financeiro: recebido 7.500, devolução 2.500, disponível 5.000', quem: 'A:gestor', metodo: 'GET', rota: () => `/legal/guarantees/${g.caucao}`, esperado: { status: 200 }, guardar: (b, x, passo) => { const tr = b && b.data && b.data.depositTrail; if (!tr || Number(tr.available) !== 5000 || tr.movements.length !== 1) passo.ok = false; } });

  // ---------- CAPITALIZATION: documento/provider/vigência ----------
  const certificado = await f('LC-GA-P6', 'certificado do titulo');
  await H({ id: 'LC-GA-08', req: [RQ.capitalization, RQ.jur006], titulo: 'Título com o código do livro CAPITALIZATION, certificado, provider e vigência: ACTIVE', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'CAPITALIZATION', value: 10000, startsAt: '2026-01-01', endsAt: '2027-01-01', providerName: 'Capitalizadora Fictícia', certificateNumber: `TC-${lc.sfx}`, certificateFileId: certificado }, esperado: { status: 201 }, guardar: guarda('titulo', 'ACTIVE', 'CAPITALIZATION') });
  await H({ id: 'LC-GA-09', req: [RQ.capitalization], titulo: 'Título pelo apelido CAPITALIZATION_TITLE sem documento nem provider: gravado como CAPITALIZATION e PENDING', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'CAPITALIZATION_TITLE', value: 10000, endsAt: '2027-01-01' }, esperado: { status: 201 }, guardar: guarda('tituloPendente', 'PENDING', 'CAPITALIZATION') });
  await H({ id: 'LC-GA-10', req: [RQ.capitalization], titulo: 'Título de capitalização sem fim de vigência é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'CAPITALIZATION', value: 10000 }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDITY_REQUIRED' } });

  // ---------- OTHER: fluxo configurado ----------
  await H({ id: 'LC-GA-11', req: [RQ.other], titulo: 'Outra garantia com fluxo não homologado pela empresa é recusada', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'OTHER', homologatedFlowCode: 'FLUXO-INEXISTENTE', value: 1000 }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_FLOW_NOT_CONFIGURED' } });
  const { upsertSetting } = require('../../../src/features/settings/settings.service');
  await R.servico({ id: 'LC-GA-37', req: [RQ.other], titulo: 'Administração homologa o fluxo "Carta de fiança bancária" (parâmetro legal.guarantee_other_flows da empresa)', chamada: "settings.service.upsertSetting('legal.guarantee_other_flows', [...])", fn: noTenant(R, (tx, t) => upsertSetting('legal.guarantee_other_flows', JSON.stringify([{ code: 'CARTA_FIANCA', label: 'Carta de fiança bancária', requiredFields: ['banco', 'numeroCarta'] }]), { groupId: t.groupId, companyId: t.companyId }, t.userId, tx)), esperado: {} });
  await H({ id: 'LC-GA-44', req: [RQ.other], titulo: 'Quem cadastra garantia (legal:create) lê os fluxos homologados sem settings:read', quem: 'A:gestor', metodo: 'GET', rota: '/legal/guarantee-flows', esperado: { status: 200 }, guardar: (b, x, passo) => { if (!b.data.some((fl) => fl.code === 'CARTA_FIANCA' && fl.requiredFields.includes('numeroCarta'))) passo.ok = false; } });
  await H({ id: 'LC-GA-45', req: [RQ.other], titulo: 'Leitura (sem legal:create) não lê os fluxos homologados', quem: 'A:leitura', metodo: 'GET', rota: '/legal/guarantee-flows', esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-GA-38', req: [RQ.other], titulo: 'Fluxo homologado sem os campos que ele exige é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'OTHER', homologatedFlowCode: 'CARTA_FIANCA', flowData: { banco: 'Banco Fictício' } }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  await H({ id: 'LC-GA-39', req: [RQ.other, RQ.jur006], titulo: 'Outra garantia pelo fluxo homologado com os campos exigidos: ACTIVE', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'OTHER', homologatedFlowCode: 'CARTA_FIANCA', flowData: { banco: 'Banco Fictício', numeroCarta: `CF-${lc.sfx}` }, value: 1000, startsAt: '2026-01-01' }, esperado: { status: 201 }, guardar: guarda('outra', 'ACTIVE', 'OTHER') });

  await H({ id: 'LC-GA-P8', req: [RQ.guarantor], titulo: 'Preparação: segunda pessoa fiadora (fictícia)', quem: 'A:gestor', metodo: 'POST', rota: '/people', corpo: { personType: 'PF', legalName: `Fiador Substituto Fictício ${lc.sfx}` }, esperado: { status: 201 }, guardar: (b) => { g.fiador2 = b.data.id; } });
  await H({ id: 'LC-GA-46', req: [RQ.guarantor], titulo: 'PATCH troca a pessoa fiadora e a troca fica gravada', quem: 'A:gestor', metodo: 'PATCH', rota: () => `/legal/guarantees/${g.fiadorPendente}`, corpo: () => ({ guarantorPersonId: g.fiador2 }), esperado: { status: 200 } });
  await H({ id: 'LC-GA-47', req: [RQ.guarantor], titulo: 'Leitura da garantia mostra o novo fiador', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/guarantees/${g.fiadorPendente}`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (b.data.guarantorPersonId !== g.fiador2) passo.ok = false; } });

  // ---------- validações comuns, permissão e isolamento ----------
  await H({ id: 'LC-GA-12', req: [RQ.jur006], titulo: 'Tipo de garantia inventado é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'CHEQUE_CAUCAO', value: 10 }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  await H({ id: 'LC-GA-13', req: [RQ.jur006, RQ.dod2, 'M5-A0168-e76ea6'], titulo: 'Fim da vigência anterior ao início é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'INSURANCE', value: 100, startsAt: '2027-01-01', endsAt: '2026-01-01' }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  await H({ id: 'LC-GA-14', req: [RQ.jur006], titulo: 'Valor zero é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 0 }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  await H({ id: 'LC-GA-15', req: [RQ.jur006], titulo: 'Status fora da lista é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 10, status: 'Ativa' }, esperado: { status: 400, codigo: 'LEGAL_GUARANTEE_VALIDATION' } });
  await H({ id: 'LC-GA-16', req: [RQ.api], titulo: 'Leitura (sem legal:create) não cria garantia', quem: 'A:leitura', metodo: 'POST', rota, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 10 }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'LC-GA-17', req: [RQ.api], titulo: 'Tenant B não cria garantia no contrato do tenant A', quem: 'B:gestor', metodo: 'POST', rota, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 10 }, esperado: { status: 404 } });
  await H({ id: 'LC-GA-18', req: [RQ.jur006, RQ.dod1, RQ.dod2], titulo: 'Cada garantia do contrato tem status e vigência próprios', quem: 'A:leitura', metodo: 'GET', rota: `/legal/guarantees?contractId=${ct.id}`, esperado: { status: 200 } });
  await H({ id: 'LC-GA-19', req: [RQ.jur006, 'M5-A0163-9b1694'], titulo: 'Liberação de uma garantia muda só o status dela', quem: 'A:gestor', metodo: 'PATCH', rota: () => `/legal/guarantees/${g.outra}`, corpo: { status: 'RELEASED' }, esperado: { status: 200 } });

  // ---------- substituição pela API preserva histórico ----------
  const apolice2 = await f('LC-GA-P7', 'apolice renovada');
  await H({ id: 'LC-GA-20', req: [RQ.vencendo, RQ.dod1, RQ.insurance], titulo: 'POST /legal/guarantees/:id/replace: seguro-fiança substituído pela apólice renovada; a antiga vira RELEASED ligada à nova', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/guarantees/${g.seguro}/replace`, corpo: { ...seguro, value: 32000, startsAt: '2027-01-01', endsAt: '2028-01-01', policyNumber: `AP2-${lc.sfx}`, policyFileId: apolice2, renewalDueAt: '2027-12-01' }, esperado: { status: 201 }, guardar: (b) => { g.seguroNovo = b.data.newGuarantee.id; } });
  await H({ id: 'LC-GA-40', req: [RQ.vencendo], titulo: 'Substituir de novo a garantia já substituída é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/guarantees/${g.seguro}/replace`, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 1 }, esperado: { status: 409, codigo: 'LEGAL_GUARANTEE_ALREADY_REPLACED' } });
  await R.sqlTenant({
    id: 'LC-GA-21', req: [RQ.vencendo, RQ.jur006], quem: 'A:leitura', descricao: 'Garantia substituída continua no banco com tipo, valor, apólice e vigência originais e aponta para a nova',
    sql: 'SELECT id, guarantee_type, value, status, starts_at, ends_at, policy_number, replaced_by_guarantee_id, deleted_at FROM legal.guarantees WHERE contract_id = :c ORDER BY created_at',
    replacements: () => ({ c: ct.id }),
    avaliar: (rows) => rows.some((r) => r.id === g.seguro && r.status === 'RELEASED' && r.replaced_by_guarantee_id === g.seguroNovo && Number(r.value) === 30000 && r.policy_number === `AP-${lc.sfx}` && !r.deleted_at),
  });

  // ---------- vencimento: tarefa + evento (JUR-TS-005) ----------
  const hoje = new Date();
  const em10 = new Date(hoje.getTime() + 10 * 86400000).toISOString().slice(0, 10);
  const ontem = new Date(hoje.getTime() - 86400000).toISOString().slice(0, 10);
  await H({ id: 'LC-GA-22', req: [RQ.vencendo, RQ.ts005], titulo: 'Fiança vencendo em 10 dias (dentro da janela de alerta)', quem: 'A:gestor', metodo: 'PATCH', rota: () => `/legal/guarantees/${g.fiador}`, corpo: { endsAt: em10 }, esperado: { status: 200 } });
  await H({ id: 'LC-GA-23', req: [RQ.ts005], titulo: 'Título de capitalização já vencido ontem (status ainda ACTIVE)', quem: 'A:gestor', metodo: 'PATCH', rota: () => `/legal/guarantees/${g.titulo}`, corpo: { startsAt: '2025-01-01', endsAt: ontem }, esperado: { status: 200 } });
  const job = require('../../../src/engines/jobs/legalGuaranteeExpiryAlertJob');
  await R.servico({ id: 'LC-GA-24', req: [RQ.vencendo, RQ.ts005, RQ.evtExpP1, RQ.evtExpP2, RQ.dod1], titulo: 'Job diário de garantias alerta a que vence em 10 dias e a já vencida', chamada: 'legalGuaranteeExpiryAlertJob.processGuaranteesInTransaction(tx)', fn: noTenant(R, (tx) => job.processGuaranteesInTransaction(tx)), esperado: {} });
  await R.servico({ id: 'LC-GA-41', req: [RQ.vencendo], titulo: 'Job de novo no mesmo dia: não abre segunda tarefa para a mesma garantia', chamada: 'legalGuaranteeExpiryAlertJob.processGuaranteesInTransaction(tx) — 2ª vez', fn: noTenant(R, (tx) => job.processGuaranteesInTransaction(tx)), esperado: {} });
  await R.sqlTenant({
    id: 'LC-GA-25', req: ['M5-A0168-e76ea6', RQ.evtExpP1, RQ.evtExpP2, RQ.vencendo, RQ.ts005], quem: 'A:gestor', descricao: 'Outbox tem lease.guarantee.expiring para a fiança (10 dias) e para o título vencido (dias negativos)',
    sql: "SELECT aggregate_id, event_type, payload_json->>'daysUntilExpiry' AS dias, idempotency_key FROM integration.outbox_events WHERE event_type = 'lease.guarantee.expiring' AND aggregate_id IN (:ids)",
    replacements: () => ({ ids: [g.fiador, g.titulo] }),
    avaliar: (rows) => rows.some((r) => r.aggregate_id === g.fiador && Number(r.dias) === 10) && rows.some((r) => r.aggregate_id === g.titulo && Number(r.dias) < 0),
  });
  await R.sqlTenant({
    id: 'LC-GA-29', req: [RQ.vencendo, RQ.ts005, RQ.dod1], quem: 'A:gestor', descricao: 'Uma TAREFA aberta por garantia vencendo (fiança: alta; título vencido: urgente), para quem cadastrou o contrato',
    sql: "SELECT related_entity_id, title, status, priority, assigned_to_user_id IS NOT NULL AS tem_responsavel, due_at FROM core.tasks WHERE related_entity_type = 'legal.guarantees' AND related_entity_id IN (:ids) ORDER BY priority",
    replacements: () => ({ ids: [g.fiador, g.titulo] }),
    avaliar: (rows) => rows.length === 2 && rows.every((r) => r.status === 'OPEN' && r.tem_responsavel) && rows.some((r) => r.related_entity_id === g.titulo && r.priority === 'URGENT'),
  });
  await R.sqlTenant({
    id: 'LC-GA-26', req: [RQ.vencendo, RQ.ts005], quem: 'A:gestor', descricao: 'Trilha de auditoria do alerta automático de vencimento',
    sql: "SELECT entity_id, action, after_json->>'daysUntilExpiry' AS dias FROM audit.audit_log WHERE action = 'legal.guarantee.job_expiry_alert' AND entity_id IN (:ids)",
    replacements: () => ({ ids: [g.fiador, g.titulo] }), avaliar: (rows) => rows.length >= 2,
  });
  const dia = (d) => String(d || '').slice(0, 10);
  await H({ id: 'LC-GA-48', req: [RQ.evtExpP1, RQ.evtExpP2, RQ.vencendo], titulo: 'Depois do job, a API mostra a fiança que gerou lease.guarantee.expiring: ainda ativa e vencendo em 10 dias', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/guarantees/${g.fiador}`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (b.data.status !== 'ACTIVE' || dia(b.data.endsAt) !== em10) passo.ok = false; } });
  await H({ id: 'LC-GA-49', req: [RQ.evtExpP1, RQ.evtExpP2, RQ.ts005], titulo: 'A API mostra o título de capitalização que gerou lease.guarantee.expiring com dias negativos: vigência terminada ontem', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/guarantees/${g.titulo}`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (dia(b.data.endsAt) !== ontem) passo.ok = false; } });
  await H({ id: 'LC-GA-50', req: [RQ.evtExpP1, RQ.evtExpP2], titulo: 'Tenant B não enxerga pela API a garantia alertada do tenant A', quem: 'B:gestor', metodo: 'GET', rota: () => `/legal/guarantees/${g.fiador}`, esperado: { status: 404 } });

  // ---------- rota literal do Guia §14 ----------
  await H({ id: 'LC-GA-27', req: [RQ.api], titulo: 'Rota literal do Guia §14 POST /contracts/:id/guarantees cria a garantia com o mesmo serviço', quem: 'A:gestor', metodo: 'POST', rota: `/contracts/${ct.id}/guarantees`, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 500, startsAt: '2026-01-01' }, esperado: { status: 201 } });
  await H({ id: 'LC-GA-28', req: [RQ.api], titulo: 'Rota literal POST /contracts/:id/guarantees: leitura recebe 403 como na rota /legal', quem: 'A:leitura', metodo: 'POST', rota: `/contracts/${ct.id}/guarantees`, corpo: { guaranteeType: 'SECURITY_DEPOSIT', value: 500 }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });

  R.ctx.lcGarantias = { contrato: ct.id, ...g };
};
