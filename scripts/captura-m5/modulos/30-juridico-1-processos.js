'use strict';
/**
 * Captura do fechamento do Marco 5 — Jurídico, processos (Caderno M5 §14, Guia §14, §18).
 * HTTP real com os perfis do seed de dois tenants; SQL somente leitura com RLS.
 */
const { q, sufixo, arquivo } = require('../juridico-apoio');

module.exports = async function juridicoProcessos(R) {
  const s = sufixo();
  const H = (o) => R.http(o);
  const uid = (quem) => R.claims[quem].userId;

  await H({ id: 'JR-P01', req: q('A0102'), titulo: 'Preparação: pessoa que será parte do processo', quem: 'A:gestor', metodo: 'POST', rota: '/people', corpo: { personType: 'PF', legalName: `Réu Fictício JR ${s}` }, esperado: { status: 201 }, guardar: (b, c) => { c.jrPessoa = b.data.id; } });
  await H({
    id: 'JR-P02', req: q('A0102', 'A0217', 'A0173', 'A0271', 'A0106'), titulo: 'Cria processo com número, órgão, classe, valor estimado, risco, responsável e escalonamento', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases',
    corpo: () => ({ caseType: 'LITIGATION', caseNumber: `0001234-55.2026.8.26.${s.slice(0, 4)}`, court: '1ª Vara Cível (fictícia)', caseClass: 'Despejo por falta de pagamento', estimatedAmount: 18500.75, riskLevel: 'HIGH', summary: `Processo fictício JR ${s}`, responsibleUserId: uid('A:gestor'), escalationUserId: uid('A:checker') }),
    esperado: { status: 201 }, guardar: (b, c) => { c.jrCaso = b.data.id; },
  });
  await H({ id: 'JR-P03', req: q('A0177'), titulo: 'Perfil só de leitura não cria processo', quem: 'A:leitura', metodo: 'POST', rota: '/legal/cases', corpo: { caseType: 'LITIGATION' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-P04', req: q('A0102'), titulo: 'Risco fora da lista é recusado', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: { caseType: 'LITIGATION', riskLevel: 'ALTISSIMO' }, esperado: { status: 400, codigo: 'LEGAL_CASE_VALIDATION' } });
  await H({ id: 'JR-P05', req: q('A0102'), titulo: 'Inclui parte formal (réu) no processo', quem: 'A:maker', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/parties`, corpo: (c) => ({ personId: c.jrPessoa, partyRole: 'DEFENDANT' }), esperado: { status: 201 } });
  await H({ id: 'JR-P06', req: q('A0102'), titulo: 'A mesma pessoa no mesmo papel não entra duas vezes', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/parties`, corpo: (c) => ({ personId: c.jrPessoa, partyRole: 'DEFENDANT' }), esperado: { status: 409, codigo: 'LEGAL_CASE_PARTY_DUPLICATE' } });
  await H({ id: 'JR-P07', req: q('A0102'), titulo: 'Lista as partes do processo', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.jrCaso}/parties`, esperado: { status: 200 } });
  await H({ id: 'JR-P08', req: q('A0103', 'A0113'), titulo: 'Envia a petição inicial (arquivo fictício; SHA-256 calculado no upload)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`peticao-${s}.pdf`, `Petição inicial fictícia ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.jrPeticao = b.data.id; } });
  await H({ id: 'JR-P09', req: q('A0103'), titulo: 'Liga a petição ao processo por people.file_links', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/documents`, corpo: (c) => ({ fileId: c.jrPeticao, purpose: 'PETITION' }), esperado: { status: 201 } });
  await H({ id: 'JR-P10', req: q('A0103', 'A0177'), titulo: 'Tenant B não liga documento ao processo de A (processo não existe para B)', quem: 'B:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/documents`, corpo: (c) => ({ fileId: c.jrPeticao }), esperado: { status: 404, codigo: 'LEGAL_CASE_NOT_FOUND' } });
  await H({ id: 'JR-P11', req: q('A0103'), titulo: 'Arquivo inexistente não é ligado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/documents`, corpo: { fileId: '00000000-0000-4000-8000-000000000000' }, esperado: { status: 404, codigo: 'LEGAL_CASE_DOCUMENT_FILE_NOT_FOUND' } });
  await H({ id: 'JR-P12', req: q('A0103'), titulo: 'Lista os documentos do processo com o SHA-256 do arquivo', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.jrCaso}/documents`, esperado: { status: 200 } });
  await H({ id: 'JR-P13', req: q('A0104'), titulo: 'Mudança de fase do processo (movimentação relevante)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/cases/${c.jrCaso}`, corpo: { phase: 'DISCOVERY' }, esperado: { status: 200 } });
  await H({ id: 'JR-P13b', req: q('A0105', 'A0106'), titulo: 'Sem valor CONFIRMADO, nada vai ao Financeiro: a estimativa não vira recebível', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/receivables`, corpo: { basis: 'SETTLEMENT', basisReference: 'Acordo fictício', dueAt: '2030-03-10' }, esperado: { status: 409, codigo: 'LEGAL_CASE_RECEIVABLE_NOT_CONFIRMED' } });
  await H({ id: 'JR-P14', req: q('A0105', 'A0106'), titulo: 'Valor confirmado (acordo) gravado separado do estimado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/cases/${c.jrCaso}`, corpo: { confirmedAmount: 9000 }, esperado: { status: 200 } });
  await H({ id: 'JR-P14b', req: q('A0105'), titulo: 'Preparação: centro de resultado do Financeiro', quem: 'A:gestor', metodo: 'POST', rota: '/finance/result-centers', corpo: { code: `RC-JR-${s}`, name: `Honorários e acordos ${s}` }, esperado: { status: 201 }, guardar: (b, c) => { c.jrRc = b.data.id; } });
  const receivable = (c, extra = {}) => ({ basis: 'SETTLEMENT', basisReference: 'Acordo homologado fictício nº 77/2026', dueAt: '2030-03-10', resultCenterId: c.jrRc, ...extra });
  await H({ id: 'JR-P14c', req: q('A0105'), titulo: 'Base jurídica fora da lista (não cabível) é recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/receivables`, corpo: (c) => receivable(c, { basis: 'ESTIMATIVA' }), esperado: { status: 400, codigo: 'LEGAL_CASE_RECEIVABLE_BASIS_INVALID' } });
  await H({ id: 'JR-P14d', req: q('A0105', 'A0177'), titulo: 'Vincular ao Financeiro exige legal:approve e finance:create: leitura recusada', quem: 'A:leitura', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/receivables`, corpo: (c) => receivable(c), esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-P14e', req: q('A0105', 'A0106'), titulo: 'Valor confirmado (acordo homologado) vira recebível vinculado ao processo no Financeiro', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/receivables`, corpo: (c) => receivable(c), esperado: { status: 201 }, guardar: (b, c) => { c.jrEntry = b.data.financialEntryId; } });
  await H({ id: 'JR-P14f', req: q('A0105'), titulo: 'Segundo vínculo do mesmo processo é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.jrCaso}/receivables`, corpo: (c) => receivable(c), esperado: { status: 409, codigo: 'LEGAL_CASE_RECEIVABLE_DUPLICATE' } });
  await H({ id: 'JR-P14g', req: q('A0105'), titulo: 'Depois de vinculado, o valor confirmado não muda pelo processo', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/cases/${c.jrCaso}`, corpo: { confirmedAmount: 9500 }, esperado: { status: 409, codigo: 'LEGAL_CASE_RECEIVABLE_LOCKED' } });
  await H({ id: 'JR-P14h', req: q('A0105'), titulo: 'Lista o recebível vinculado ao processo', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.jrCaso}/receivables`, esperado: { status: 200 } });
  await H({ id: 'JR-P15', req: q('A0102'), titulo: 'Lê o processo com todos os campos', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.jrCaso}`, esperado: { status: 200 } });
  await H({ id: 'JR-P16', req: q('A0104', 'A0309'), titulo: 'Linha do tempo do processo: abertura, fase, parte e documento', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.jrCaso}/timeline`, esperado: { status: 200 }, guardar: (b, c) => { c.jrTimeline = (b && b.data && b.data.items) || []; } });
  await R.servico({
    id: 'JR-P16b', req: q('A0104'), titulo: 'O resumo da linha do tempo é português para gente (sem id, código ou data ISO crus); os dados crus ficam em details',
    chamada: 'conferência do corpo de JR-P16',
    fn: (c) => {
      const cru = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\b(LITIGATION|DISCOVERY|DEFENDANT|PETITION|legal\.[a-z_.]+|null|undefined)\b/i;
      const ruins = c.jrTimeline.filter((i) => cru.test(i.summary));
      if (!c.jrTimeline.length || ruins.length || !c.jrTimeline.every((i) => i.details)) throw Object.assign(new Error(`resumo cru: ${ruins.map((i) => i.summary).join(' | ')}`), { code: 'RESUMO_CRU' });
      return { resumos: c.jrTimeline.map((i) => i.summary) };
    },
    esperado: {},
  });
  await H({ id: 'JR-P17', req: q('A0104', 'A0177'), titulo: 'Tenant B não lê a linha do tempo do processo de A', quem: 'B:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.jrCaso}/timeline`, esperado: { status: 404, codigo: 'LEGAL_CASE_NOT_FOUND' } });

  await R.sqlTenant({
    id: 'JR-P18', req: q('A0102', 'A0103', 'A0106'), quem: 'A:leitura', descricao: 'Processo gravado: número, órgão, classe, status, risco, estimado x confirmado, responsável, partes e documentos ligados',
    sql: `SELECT c.case_number, c.court, c.case_class, c.status, c.risk_level, c.estimated_amount, c.confirmed_amount, c.responsible_user_id IS NOT NULL AS tem_responsavel,
            (SELECT count(*) FROM legal.case_parties p WHERE p.legal_case_id = c.id) AS partes,
            (SELECT count(*) FROM people.file_links fl WHERE fl.related_entity_type = 'LegalCase' AND fl.related_entity_id = c.id) AS documentos
          FROM legal.legal_cases c WHERE c.id = :id`,
    replacements: (c) => ({ id: c.jrCaso }),
    avaliar: (rows) => rows.length === 1 && rows[0].court && rows[0].case_class && rows[0].risk_level === 'HIGH' && Number(rows[0].partes) === 1 && Number(rows[0].documentos) === 1 && Number(rows[0].estimated_amount) !== Number(rows[0].confirmed_amount),
  });
  await R.sqlTenant({
    id: 'JR-P19', req: q('A0105', 'A0106'), quem: 'A:gestor', descricao: 'Recebível vinculado: lançamento RECEIVABLE com o valor CONFIRMADO (não o estimado), origem no processo e base jurídica em legal.case_receivables',
    sql: `SELECT r.basis, r.basis_reference, r.amount AS valor_vinculado, c.estimated_amount, c.confirmed_amount, e.nature, e.amount AS valor_lancamento, e.origin_ref
          FROM legal.case_receivables r JOIN legal.legal_cases c ON c.id = r.legal_case_id JOIN finance.financial_entries e ON e.id = r.financial_entry_id WHERE r.legal_case_id = :id`,
    replacements: (c) => ({ id: c.jrCaso }),
    avaliar: (rows) => rows.length === 1 && rows[0].nature === 'RECEIVABLE' && Number(rows[0].valor_lancamento) === Number(rows[0].confirmed_amount) && Number(rows[0].valor_lancamento) !== Number(rows[0].estimated_amount) && /^legal\.legal_cases:/.test(rows[0].origin_ref),
  });
  await R.sqlTenant({
    id: 'JR-P20', req: q('A0138', 'A0273'), quem: 'A:gestor', descricao: 'Evento legal.case.created no outbox para o processo criado',
    sql: 'SELECT event_type, aggregate_type FROM integration.outbox_events WHERE aggregate_id = :id ORDER BY created_at',
    replacements: (c) => ({ id: c.jrCaso }),
    avaliar: (rows) => rows.some((r) => r.event_type === 'legal.case.created'),
  });
  await R.sqlTenant({
    id: 'JR-P21', req: q('A0104'), quem: 'A:gestor', descricao: 'Trilha de auditoria (append-only) que alimenta a linha do tempo: mudança de fase com antes/depois e documento ligado',
    sql: "SELECT action, before_json->>'phase' AS fase_antes, after_json->>'phase' AS fase_depois, reason FROM audit.audit_log WHERE entity_type = 'LegalCase' AND entity_id = :id ORDER BY occurred_at",
    replacements: (c) => ({ id: c.jrCaso }),
    avaliar: (rows) => rows.some((r) => r.action === 'legal.case.phase_change' && r.fase_depois === 'DISCOVERY') && rows.some((r) => r.action === 'legal.case.document_link'),
  });
};
