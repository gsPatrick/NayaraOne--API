'use strict';
/**
 * Locação — Vistorias (Caderno M5 §11, JUR-007, JUR-TS-006, §18 inspection.*, Guia §9/§10/§14/§16/§19/§20).
 * HTTP real; a assinatura exige MFA recente na rota (recusa capturada) e é feita pela camada de
 * serviço com o mesmo `signInspection` que a rota chama.
 */
const { preparo, contratoLocacao, arquivo, noTenant } = require('../apoio-locacao/preparo');

const RQ = {
  jur007: 'M5-A0009-e79a24', tipos: 'M5-A0087-6b7f4a', itens: 'M5-A0088-cf4120', midias: 'M5-A0089-3a7a69',
  congela: 'M5-A0090-d03b23', revisao: 'M5-A0091-ff8232', compara: 'M5-A0092-c94934', evtSignedP1: 'M5-A0134-26015d',
  evtDiff: 'M5-A0135-ebb9f7', ts006: 'M5-A0154-31578b', dod1: 'M5-A0170-eac51d', guiaItem: 'M5-A0202-a24762',
  guiaCmp1: 'M5-A0203-c813f9', guiaCmp2: 'M5-A0204-fc6bab', apiCriar: 'M5-A0214-41f7b0', apiAssinar: 'M5-A0215-5e9a8f',
  evtSignedP2: 'M5-A0225-980dfe', imutavel: 'M5-A0237-3d4204', naoEditar: 'M5-A0256-42d414', dod2: 'M5-A0268-8ec039',
};
const IMUT = [RQ.congela, RQ.imutavel, RQ.naoEditar, RQ.dod2, RQ.jur007];

module.exports = async function locacaoVistorias(R) {
  const lc = await preparo(R);
  const H = (o) => R.http(o);
  const ct = await contratoLocacao(R, 'LC-VI-P1', { propertyId: lc.imovel, locadorId: lc.locador, locatarioId: lc.locatario, valor: 2700 });
  const v = {};
  const nova = (id, tipo, chave, req) => H({ id, req, titulo: `Cria vistoria do tipo ${tipo} (código do livro)`, quem: 'A:gestor', metodo: 'POST', rota: '/legal/inspections', corpo: { propertyId: lc.imovel, contractId: ct.id, inspectionType: tipo }, esperado: { status: 201 }, guardar: (b) => { v[chave] = b.data.id; } });

  // ---------- tipos ----------
  await nova('LC-VI-01', 'ENTRY', 'entrada', ['M5-A0009-e79a24', RQ.tipos, RQ.apiCriar, RQ.dod1]);
  await H({ id: 'LC-VI-51', req: [RQ.tipos], titulo: 'Código antigo CHECK_OUT na entrada é aceito como apelido e devolvido como EXIT', quem: 'A:gestor', metodo: 'POST', rota: '/legal/inspections', corpo: { propertyId: lc.imovel, inspectionType: 'CHECK_OUT' }, esperado: { status: 201 }, guardar: (b, x, passo) => { if (b.data.inspectionType !== 'EXIT') passo.ok = false; } });
  await nova('LC-VI-02', 'EXIT', 'saida', ['M5-A0009-e79a24', RQ.tipos, RQ.apiCriar, RQ.dod1]);
  await nova('LC-VI-03', 'INTERMEDIATE', 'intermediaria', [RQ.tipos, RQ.apiCriar]);
  await nova('LC-VI-04', 'FINAL', 'final', [RQ.tipos, RQ.apiCriar]);
  await H({ id: 'LC-VI-05', req: [RQ.tipos], titulo: 'Tipo de vistoria inventado é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/legal/inspections', corpo: { propertyId: lc.imovel, contractId: ct.id, inspectionType: 'SURPRESA' }, esperado: { status: 400, codigo: 'LEGAL_INSPECTION_VALIDATION' } });
  await H({ id: 'LC-VI-06', req: [RQ.apiCriar], titulo: 'Leitura (sem legal:create) não cria vistoria', quem: 'A:leitura', metodo: 'POST', rota: '/legal/inspections', corpo: { propertyId: lc.imovel, inspectionType: 'ENTRY' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.sqlTenant({ id: 'LC-VI-07', req: [RQ.tipos], quem: 'A:leitura', descricao: 'Tipo gravado de cada vistoria: o código do livro (ENTRY/EXIT/INTERMEDIATE/FINAL)', sql: 'SELECT id, inspection_type, status FROM legal.inspections WHERE contract_id = :c ORDER BY created_at', replacements: () => ({ c: ct.id }), avaliar: (rows) => rows.length === 4 && rows.map((r) => r.inspection_type).join(',') === 'ENTRY,EXIT,INTERMEDIATE,FINAL' });

  // ---------- itens estruturados ----------
  const item = (id, insp, corpo, esperado, req, guardarComo) => H({ id, req, titulo: corpo.titulo, quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v[insp]}/items`, corpo: corpo.dados, esperado, guardar: (b) => { if (guardarComo && b && b.data) v[guardarComo] = b.data.id; } });
  await item('LC-VI-08', 'entrada', { titulo: 'Item em bom estado com observação', dados: { itemName: 'Sala — piso', condition: 'GOOD', notes: 'Piso laminado sem riscos' } }, { status: 201 }, [RQ.itens, RQ.guiaItem], 'itemSala');
  await item('LC-VI-09', 'entrada', { titulo: 'Item regular com observação', dados: { itemName: 'Cozinha — armário', condition: 'REGULAR', notes: 'Porta com folga' } }, { status: 201 }, [RQ.itens]);
  await item('LC-VI-10', 'entrada', { titulo: 'Item danificado sem descrição do dano é recusado', dados: { itemName: 'Banheiro — box', condition: 'DAMAGED', estimatedBudget: 300, responsibleParty: 'TENANT' } }, { status: 400, codigo: 'LEGAL_INSPECTION_ITEM_VALIDATION' }, [RQ.itens]);
  await item('LC-VI-11', 'entrada', { titulo: 'Item danificado sem responsabilidade é recusado', dados: { itemName: 'Banheiro — box', condition: 'DAMAGED', damageDescription: 'Vidro trincado', estimatedBudget: 300 } }, { status: 400, codigo: 'LEGAL_INSPECTION_ITEM_VALIDATION' }, [RQ.itens]);
  await item('LC-VI-12', 'entrada', { titulo: 'Item danificado com descrição, orçamento e responsabilidade', dados: { itemName: 'Banheiro — box', condition: 'DAMAGED', damageDescription: 'Vidro trincado no canto', estimatedBudget: 300, responsibleParty: 'LANDLORD', notes: 'Já existia antes da locação' } }, { status: 201 }, [RQ.itens]);
  await item('LC-VI-13', 'entrada', { titulo: 'Condição NEW do Guia §9 aceita, com ambiente e código do item informados', dados: { itemName: 'Pintura das paredes', roomCode: 'QUARTO', itemCode: 'PINTURA', condition: 'NEW', description: 'Pintura nova entregue ao locatário', notes: 'Branco gelo', responsibleParty: 'LANDLORD' } }, { status: 201 }, [RQ.guiaItem, RQ.itens], 'itemPintura');
  await item('LC-VI-14', 'entrada', { titulo: 'Ambiente e código derivados do nome "Ambiente — item" quando a chamada não os traz', dados: { itemName: 'Quarto — janela', condition: 'GOOD' } }, { status: 201 }, [RQ.guiaItem, RQ.itens], 'itemJanela');
  await item('LC-VI-48', 'entrada', { titulo: 'Condição fora de NEW/GOOD/REGULAR/DAMAGED é recusada', dados: { itemName: 'Quarto — porta', condition: 'OTIMO' } }, { status: 400, codigo: 'LEGAL_INSPECTION_ITEM_VALIDATION' }, [RQ.guiaItem, RQ.itens]);
  await R.sqlTenant({ id: 'LC-VI-49', req: [RQ.itens, RQ.guiaItem], quem: 'A:leitura', descricao: 'Itens estruturados por ambiente: room_code, item_code, condição, descrição, observação e responsabilidade', sql: 'SELECT room_code, item_code, item_name, condition, description, notes, responsible_party FROM legal.inspection_items WHERE inspection_id = :i AND deleted_at IS NULL ORDER BY room_code, item_code', replacements: () => ({ i: v.entrada }), avaliar: (rows) => rows.length === 5 && rows.every((r) => r.room_code && r.item_code) && rows.some((r) => r.condition === 'NEW' && r.room_code === 'QUARTO' && r.item_code === 'PINTURA') && rows.some((r) => r.room_code === 'QUARTO' && r.item_code === 'JANELA') });

  // ---------- mídias com hash, data/hora e vínculo ao item ----------
  const foto = await arquivo(R, 'LC-VI-15', 'Foto do piso da sala (imagem fictícia)', 'piso-sala.jpg', `JPEG fictício ${lc.sfx}`, 'image/jpeg', [RQ.midias]);
  await H({ id: 'LC-VI-16', req: [RQ.midias], titulo: 'Anexa a foto ao item da vistoria', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/items/${v.itemSala}/media`, corpo: { fileId: foto, mediaType: 'PHOTO' }, esperado: { status: 201 } });
  await H({ id: 'LC-VI-17', req: [RQ.midias], titulo: 'Arquivo inexistente não vira mídia do item', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/items/${v.itemSala}/media`, corpo: { fileId: '00000000-0000-4000-8000-000000000003', mediaType: 'PHOTO' }, esperado: { status: 404, codigo: 'LEGAL_INSPECTION_MEDIA_FILE_NOT_FOUND' } });
  await H({ id: 'LC-VI-18', req: [RQ.midias], titulo: 'Lista as mídias do item a partir de legal.inspection_media, com sha256 e data/hora', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/inspections/items/${v.itemSala}/media`, esperado: { status: 200 }, guardar: (b, x, passo) => { const m = b && b.data && b.data[0]; if (!m || !/^[0-9a-f]{64}$/.test(m.sha256) || !m.capturedAt || m.fileId !== foto) passo.ok = false; } });
  await R.sqlTenant({
    id: 'LC-VI-19', req: [RQ.midias], quem: 'A:leitura', descricao: 'Mídia na tabela do livro legal.inspection_media: vistoria, item, arquivo, SHA-256 (confere com o arquivo), data/hora e tipo',
    sql: 'SELECT m.inspection_id, m.item_id, m.file_id, m.sha256, m.captured_at, m.media_type, f.checksum_sha256 = m.sha256 AS hash_confere FROM legal.inspection_media m JOIN people.files f ON f.id = m.file_id WHERE m.item_id = :item',
    replacements: () => ({ item: v.itemSala }), avaliar: (rows) => rows.length === 1 && /^[0-9a-f]{64}$/.test(rows[0].sha256) && rows[0].hash_confere && rows[0].inspection_id === v.entrada && rows[0].media_type === 'PHOTO',
  });

  // ---------- assinatura congela ----------
  await H({ id: 'LC-VI-20', req: [RQ.apiAssinar], titulo: 'Assinar antes de concluir: a rota exige MFA recente primeiro (recusa sem step-up)', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.entrada}/sign`, corpo: { partyRole: 'LANDLORD', signaturePayload: 'aceite' }, esperado: { status: 403 } });
  const insp = require('../../../src/modules/legal/inspections/inspection.service');
  const assina = (id, chave, papel, esperado, titulo, req) => R.servico({ id, req, titulo, chamada: `inspections.service.signInspection(${chave}, {${papel}})`, fn: noTenant(R, (tx, t) => insp.signInspection(v[chave], { partyRole: papel, signaturePayload: `Aceite ${papel} (fictício)` }, t.userId, tx)), esperado });
  await assina('LC-VI-21', 'entrada', 'LANDLORD', { erro: 'LEGAL_INSPECTION_NOT_COMPLETED' }, 'Vistoria não concluída não pode ser assinada', [RQ.guiaItem, RQ.apiAssinar]);
  await H({ id: 'LC-VI-22', req: [RQ.dod1], titulo: 'Conclui a vistoria de entrada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.entrada}/complete`, corpo: {}, esperado: { status: 200 } });
  await assina('LC-VI-23', 'entrada', 'LANDLORD', {}, 'Locador assina a vistoria de entrada', ['M5-A0268-8ec039', 'M5-A0202-a24762', 'M5-A0090-d03b23', RQ.apiAssinar, RQ.dod1, RQ.evtSignedP1, RQ.evtSignedP2]);
  await assina('LC-VI-24', 'entrada', 'TENANT', {}, 'Locatário assina a vistoria de entrada', ['M5-A0202-a24762', 'M5-A0268-8ec039', 'M5-A0170-eac51d', RQ.apiAssinar, RQ.evtSignedP1, RQ.evtSignedP2]);
  await assina('LC-VI-25', 'entrada', 'LANDLORD', { erro: 'LEGAL_INSPECTION_ALREADY_SIGNED' }, 'A mesma parte não assina duas vezes', [RQ.apiAssinar]);
  await H({ id: 'LC-VI-26', req: [...IMUT, RQ.ts006], titulo: 'Vistoria assinada: item novo é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.entrada}/items`, corpo: { itemName: 'Área — acréscimo', condition: 'GOOD' }, esperado: { status: 409, codigo: 'LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE' } });
  await H({ id: 'LC-VI-27', req: IMUT, titulo: 'Vistoria assinada: mídia nova é recusada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/items/${v.itemSala}/media`, corpo: { fileId: foto, mediaType: 'PHOTO' }, esperado: { status: 409, codigo: 'LEGAL_INSPECTION_IMMUTABLE_AFTER_SIGNATURE' } });
  await H({ id: 'LC-VI-28', req: IMUT, titulo: 'Não existe rota de edição da vistoria (PATCH)', quem: 'A:gestor', metodo: 'PATCH', rota: () => `/legal/inspections/${v.entrada}`, corpo: { status: 'SCHEDULED' }, esperado: { status: 404 } });
  await H({ id: 'LC-VI-29', req: IMUT, titulo: 'Concluir de novo é recusado', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.entrada}/complete`, corpo: {}, esperado: { status: 409, codigo: 'LEGAL_INSPECTION_ALREADY_COMPLETED' } });
  await H({ id: 'LC-VI-30', req: [RQ.apiAssinar], titulo: 'Assinaturas da vistoria com hash', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/inspections/${v.entrada}/signatures`, esperado: { status: 200 } });
  await R.sqlTenant({ id: 'LC-VI-31', req: [RQ.evtSignedP1, RQ.evtSignedP2], quem: 'A:gestor', descricao: 'Outbox: inspection.signed, uma ocorrência por parte que assinou', sql: "SELECT event_type, idempotency_key, payload_json->>'partyRole' AS papel FROM integration.outbox_events WHERE event_type = 'inspection.signed' AND aggregate_id = :id", replacements: () => ({ id: v.entrada }), avaliar: (rows) => rows.length === 2 });

  await H({ id: 'LC-VI-54', req: [RQ.evtSignedP1, RQ.evtSignedP2, RQ.apiAssinar], titulo: 'A API lista as duas assinaturas que publicaram inspection.signed (locador e locatário), com o mesmo hash do conteúdo', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/inspections/${v.entrada}/signatures`, esperado: { status: 200 }, guardar: (b, x, passo) => { const s = (b && b.data) || []; const papeis = s.map((i) => i.partyRole).sort().join(','); if (papeis !== 'LANDLORD,TENANT' || !/^[0-9a-f]{64}$/.test(s[0].snapshotHash || '') || s[0].snapshotHash !== s[1].snapshotHash) passo.ok = false; } });
  await H({ id: 'LC-VI-55', req: [RQ.evtSignedP1, RQ.evtSignedP2], titulo: 'Tenant B consulta as assinaturas da vistoria do tenant A e não recebe nenhuma (RLS)', quem: 'B:gestor', metodo: 'GET', rota: () => `/legal/inspections/${v.entrada}/signatures`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (!b || !Array.isArray(b.data) || b.data.length !== 0) passo.ok = false; } });
  await R.sqlTenant({ id: 'LC-VI-50', req: [RQ.guiaItem, RQ.congela, RQ.imutavel], quem: 'A:leitura', descricao: 'As duas assinaturas guardam o MESMO hash canônico do conteúdo da vistoria (snapshot_hash)', sql: 'SELECT party_role, snapshot_hash, signature_hash FROM legal.inspection_signatures WHERE inspection_id = :i ORDER BY signed_at', replacements: () => ({ i: v.entrada }), avaliar: (rows) => rows.length === 2 && /^[0-9a-f]{64}$/.test(rows[0].snapshot_hash) && rows[0].snapshot_hash === rows[1].snapshot_hash });

  // ---------- revisão (JUR-TS-006) ----------
  await H({ id: 'LC-VI-32', req: [RQ.revisao, RQ.ts006], titulo: 'Revisão sem motivo é recusada', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.entrada}/revisions`, corpo: {}, esperado: { status: 400, codigo: 'LEGAL_INSPECTION_REVISION_REASON_REQUIRED' } });
  await H({ id: 'LC-VI-33', req: [RQ.revisao, RQ.ts006], titulo: 'Revisão só existe para laudo assinado', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.saida}/revisions`, corpo: { reason: 'correção' }, esperado: { status: 409, codigo: 'LEGAL_INSPECTION_REVISION_NOT_SIGNED' } });
  await H({ id: 'LC-VI-34', req: [RQ.revisao, RQ.ts006, RQ.jur007], titulo: 'Correção após assinatura cria revisão (nova vistoria apontando para a original)', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.entrada}/revisions`, corpo: { reason: 'Corrigir a descrição do armário da cozinha' }, esperado: { status: 201 }, guardar: (b) => { v.revisao = b.data.id; } });
  await R.sqlTenant({
    id: 'LC-VI-35', req: [RQ.revisao, RQ.ts006, RQ.jur007, ...IMUT], quem: 'A:leitura', descricao: 'Original intacto (status, itens e assinaturas) e revisão com os itens copiados e o motivo',
    sql: "SELECT i.id, i.status, i.revision_of_inspection_id, i.revision_reason, (SELECT count(*) FROM legal.inspection_items it WHERE it.inspection_id = i.id AND it.deleted_at IS NULL) AS itens, (SELECT count(*) FROM legal.inspection_signatures s WHERE s.inspection_id = i.id) AS assinaturas FROM legal.inspections i WHERE i.id IN (:a, :b)",
    replacements: () => ({ a: v.entrada, b: v.revisao }),
    avaliar: (rows) => { const o = rows.find((r) => r.id === v.entrada); const n = rows.find((r) => r.id === v.revisao); return o && n && o.status === 'COMPLETED' && Number(o.assinaturas) === 2 && n.revision_of_inspection_id === v.entrada && Number(n.itens) === Number(o.itens) && Number(n.assinaturas) === 0; },
  });

  // ---------- saída e comparação entrada x saída ----------
  await item('LC-VI-36', 'saida', { titulo: 'Saída: piso da sala danificado', dados: { itemName: 'Sala — piso', condition: 'DAMAGED', damageDescription: 'Riscos profundos', estimatedBudget: 850, responsibleParty: 'UNDETERMINED' } }, { status: 201 }, [RQ.compara]);
  await item('LC-VI-37', 'saida', { titulo: 'Saída: armário da cozinha igual à entrada', dados: { itemName: 'Cozinha — armário', condition: 'REGULAR' } }, { status: 201 }, [RQ.compara]);
  await H({ id: 'LC-VI-38', req: [RQ.compara], titulo: 'Conclui a vistoria de saída', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.saida}/complete`, corpo: {}, esperado: { status: 200 } });
  await H({
    id: 'LC-VI-39', req: [RQ.compara, RQ.dod1, RQ.guiaCmp1, RQ.guiaCmp2], titulo: 'Compara entrada x saída por ambiente + código do item: antes/depois, mudou?, mídias e validação humana', quem: 'A:leitura', metodo: 'GET',
    rota: () => `/legal/inspections/compare?entryInspectionId=${v.entrada}&exitInspectionId=${v.saida}`, esperado: { status: 200 },
    guardar: (b, x, passo) => { const it = (b && b.data && b.data.items) || []; const sala = it.find((i) => i.itemName === 'Sala — piso'); if (!sala || sala.roomCode !== 'SALA' || sala.itemCode !== 'PISO' || sala.before !== 'GOOD' || sala.after !== 'DAMAGED' || sala.changed !== true || sala.mediaRefs.length !== 1 || !b.data.requiresHumanValidation) passo.ok = false; },
  });
  await assina('LC-VI-40', 'saida', 'TENANT', {}, 'Locatário assina a saída: dispara a detecção de diferenças', [RQ.compara, RQ.evtDiff]);
  await R.sqlTenant({ id: 'LC-VI-41', req: [RQ.evtDiff, RQ.compara], quem: 'A:gestor', descricao: 'Outbox: inspection.difference.detected com as divergências entrada x saída', sql: "SELECT event_type, payload_json FROM integration.outbox_events WHERE event_type = 'inspection.difference.detected' AND payload_json::text LIKE :id", replacements: () => ({ id: `%${v.saida}%` }), avaliar: (rows) => rows.length === 1 });
  await H({ id: 'LC-VI-56', req: [RQ.evtDiff, RQ.compara], titulo: 'Após a assinatura da saída, a API devolve as mesmas divergências publicadas em inspection.difference.detected (piso da sala: GOOD → DAMAGED)', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/inspections/compare?entryInspectionId=${v.entrada}&exitInspectionId=${v.saida}`, esperado: { status: 200 }, guardar: (b, x, passo) => { const d = (b && b.data && b.data.divergences) || []; if (!d.some((i) => i.itemName === 'Sala — piso' && i.entryCondition === 'GOOD' && i.exitCondition === 'DAMAGED') || b.data.exitInspectionId !== v.saida) passo.ok = false; } });
  await H({ id: 'LC-VI-57', req: [RQ.evtDiff], titulo: 'A API mostra a assinatura do locatário na saída, o gatilho da detecção de diferenças', quem: 'A:leitura', metodo: 'GET', rota: () => `/legal/inspections/${v.saida}/signatures`, esperado: { status: 200 }, guardar: (b, x, passo) => { if (!((b && b.data) || []).some((s) => s.partyRole === 'TENANT')) passo.ok = false; } });
  await R.sqlTenant({ id: 'LC-VI-42', req: ['M5-A0261-d6fe86', RQ.compara, RQ.guiaCmp2], quem: 'A:gestor', descricao: 'Nenhuma cobrança nasce sozinha da diferença: zero lançamentos financeiros no contrato (humano valida)', sql: 'SELECT count(*)::int AS lancamentos FROM finance.financial_entries WHERE contract_id = :c', replacements: () => ({ c: ct.id }), avaliar: (rows) => rows[0].lancamentos === 0 });

  // ---------- relatório e isolamento ----------
  await H({ id: 'LC-VI-43', req: [RQ.jur007, RQ.dod2], titulo: 'Relatório PDF da vistoria assinada com hash', quem: 'A:gestor', metodo: 'POST', rota: () => `/legal/inspections/${v.entrada}/report`, corpo: {}, esperado: { status: 201 } });
  await H({ id: 'LC-VI-44', req: [RQ.apiCriar], titulo: 'Tenant B não lê a vistoria do tenant A', quem: 'B:gestor', metodo: 'GET', rota: () => `/legal/inspections/${v.entrada}`, esperado: { status: 404 } });
  await H({ id: 'LC-VI-45', req: [RQ.jur007], titulo: 'Lista as vistorias de entrada pelo código do livro', quem: 'A:leitura', metodo: 'GET', rota: `/legal/inspections?contractId=${ct.id}&inspectionType=ENTRY`, esperado: { status: 200 } });

  await H({ id: 'LC-VI-46', req: [RQ.apiCriar, RQ.tipos], titulo: 'Rota literal do Guia §14 POST /inspections cria a vistoria com o mesmo serviço', quem: 'A:gestor', metodo: 'POST', rota: '/inspections', corpo: { propertyId: lc.imovel, contractId: ct.id, inspectionType: 'INTERMEDIATE' }, esperado: { status: 201 }, guardar: (b) => { v.literal = b.data.id; } });
  await H({ id: 'LC-VI-47', req: [RQ.apiAssinar], titulo: 'Rota literal POST /inspections/:id/sign exige MFA recente como a rota /legal (recusa sem step-up)', quem: 'A:gestor', metodo: 'POST', rota: () => `/inspections/${v.entrada}/sign`, corpo: { partyRole: 'INSPECTOR', signaturePayload: 'vistoriador' }, esperado: { status: 403 } });

  await H({ id: 'LC-VI-52', req: [RQ.apiCriar], titulo: 'Pentest: tenant B não cria vistoria apontando para o imóvel e o contrato do tenant A (404, nada gravado)', quem: 'B:gestor', metodo: 'POST', rota: '/legal/inspections', corpo: { propertyId: lc.imovel, contractId: ct.id, inspectionType: 'ENTRY' }, esperado: { status: 404, codigo: 'LEGAL_INSPECTION_PROPERTY_NOT_FOUND' } });
  await H({ id: 'LC-VI-53', req: [RQ.apiCriar], titulo: 'Pentest: objeto no lugar do id do imóvel é 400, não 500', quem: 'A:gestor', metodo: 'POST', rota: '/inspections', corpo: { propertyId: { $gt: '' }, inspectionType: 'ENTRY' }, esperado: { status: 400, codigo: 'LEGAL_INSPECTION_VALIDATION' } });
  R.ctx.lcVistorias = { contrato: ct.id, ...v };
};
