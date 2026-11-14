'use strict';
/**
 * Captura do fechamento do Marco 5 — Jurídico, NAY Jurídica (Caderno M5 §17, JUR-008, JUR-TS-012,
 * DoD "NAY jurídica com confirmação humana em ações críticas", Guia §16/§19). Somente leitura e
 * sugestão; a prova de que nada muda vem das consultas antes/depois.
 */
const { q, sufixo, arquivo } = require('../juridico-apoio');

module.exports = async function juridicoNay(R) {
  const s = sufixo();
  const H = (o) => R.http(o);

  await H({ id: 'JR-Y01', req: q('A0119'), titulo: 'Preparação: contrato de locação', quem: 'A:gestor', metodo: 'POST', rota: '/legal/contracts', corpo: { contractType: 'LEASE_RESIDENTIAL', totalValue: 3100 }, esperado: { status: 201 }, guardar: (b, c) => { c.nyContrato = b.data.id; } });
  await H({ id: 'JR-Y02', req: q('A0119'), titulo: 'Preparação: checklist documental do contrato (itens pendentes)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.nyContrato}/requirements/generate`, corpo: {}, esperado: { status: 201 } });
  await H({ id: 'JR-Y03', req: q('A0120'), titulo: 'Preparação: documento da versão 1', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`contrato-v1-${s}.pdf`, `Contrato v1 ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.nyF1 = b.data.id; } });
  await H({ id: 'JR-Y04', req: q('A0120'), titulo: 'Preparação: versão 1 do contrato', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.nyContrato}/versions`, corpo: (c) => ({ content: `Cláusula 1 - aluguel de R$ 3.100,00.\nCláusula 2 - vigência de 30 meses.\n${s}`, documentFileId: c.nyF1 }), esperado: { status: 201 } });
  await H({ id: 'JR-Y05', req: q('A0120'), titulo: 'Preparação: versão 2 do contrato (aluguel alterado)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/contracts/${c.nyContrato}/versions`, corpo: (c) => ({ content: `Cláusula 1 - aluguel de R$ 3.300,00.\nCláusula 2 - vigência de 30 meses.\n${s}`, documentFileId: c.nyF1 }), esperado: { status: 201 } });
  await H({ id: 'JR-Y06', req: q('A0119', 'A0123'), titulo: 'Preparação: processo ligado ao contrato', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: (c) => ({ caseType: 'COLLECTION', caseNumber: `NY-${s}`, contractId: c.nyContrato }), esperado: { status: 201 }, guardar: (b, c) => { c.nyCaso = b.data.id; } });
  await R.sqlTenant({
    id: 'JR-Y07', req: q('A0125', 'A0241', 'A0260', 'A0122'), quem: 'A:gestor', descricao: 'Retrato ANTES da NAY: prazos do processo, versões, checklist e dossiês',
    sql: `SELECT (SELECT count(*) FROM legal.legal_deadlines WHERE legal_case_id = :caso) AS prazos, (SELECT count(*) FROM legal.contract_versions WHERE contract_id = :ct) AS versoes,
            (SELECT string_agg(status, ',' ORDER BY id) FROM legal.contract_requirements WHERE contract_id = :ct) AS checklist, (SELECT count(*) FROM legal.evidence_packages WHERE legal_case_id = :caso) AS dossies`,
    replacements: (c) => ({ caso: c.nyCaso, ct: c.nyContrato }),
    avaliar: (rows, c) => { c.nyAntes = rows[0]; return Number(rows[0].versoes) === 2 && Number(rows[0].prazos) === 0; },
  });
  await H({ id: 'JR-Y08', req: q('A0119', 'A0124', 'A0305', 'A0125', 'A0260'), titulo: 'NAY resume o contrato e aponta documentos faltantes do checklist (com fontes e aviso)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/nay/contracts/${c.nyContrato}/summary`, esperado: { status: 200 } });
  await H({ id: 'JR-Y09', req: q('A0119', 'A0124'), titulo: 'NAY resume o processo e aponta documentos faltantes (checklist do contrato e processo sem documento)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/nay/cases/${c.nyCaso}/summary`, esperado: { status: 200 }, guardar: (b, c) => { c.nyResumo = b.data; } });
  await R.servico({ id: 'JR-Y10', req: q('A0119'), titulo: 'O resumo do processo traz documentosFaltantes e pontos de atenção', chamada: 'conferência do corpo de JR-Y09', fn: (c) => { const r = c.nyResumo; if (!r.documentosFaltantes.length || !r.pontosDeAtencao.some((p) => /sem nenhum documento/.test(p))) throw Object.assign(new Error('sem faltantes'), { code: 'SEM_FALTANTES' }); return { documentosFaltantes: r.documentosFaltantes.length, pontosDeAtencao: r.pontosDeAtencao }; }, esperado: {} });
  await H({ id: 'JR-Y11', req: q('A0120', 'A0125', 'A0260'), titulo: 'NAY compara a versão 1 com a 2 (linhas removidas/incluídas e hashes)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/nay/contracts/${c.nyContrato}/compare?from=1&to=2`, esperado: { status: 200 } });
  await H({ id: 'JR-Y12', req: q('A0120'), titulo: 'Comparar a versão com ela mesma é recusado', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/nay/contracts/${c.nyContrato}/compare?from=1&to=1`, esperado: { status: 400 } });
  await H({ id: 'JR-Y13', req: q('A0121'), titulo: 'NAY sugere minuta só com cláusulas da biblioteca homologada', quem: 'A:leitura', metodo: 'GET', rota: '/legal/nay/clause-suggestions', esperado: { status: 200 } });
  await H({
    id: 'JR-Y14', req: q('A0176', 'A0275', 'A0122', 'A0160', 'A0241', 'A0305', 'A0175', 'A0274'), titulo: 'JUR-TS-012: NAY extrai datas (uma inexistente, outra possivelmente errada): tudo PENDING_CONFIRMATION, não crítico, nenhum prazo criado', quem: 'A:leitura', metodo: 'POST', rota: '/legal/nay/deadline-suggestions',
    corpo: (c) => ({ legalCaseId: c.nyCaso, text: 'Audiência em 31/02/2026. Intime-se para manifestação até 13/11/2026, no prazo de 5 dias úteis.', referenceDate: '2026-11-03T12:00:00-03:00' }), esperado: { status: 200 },
  });
  await H({ id: 'JR-Y15', req: q('A0123', 'A0125', 'A0260'), titulo: 'NAY organiza o dossiê do processo por fatos (ordem cronológica) e fontes', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/nay/cases/${c.nyCaso}/dossier`, esperado: { status: 200 } });
  await H({ id: 'JR-Y16', req: q('A0119', 'A0177'), titulo: 'Tenant B não obtém resumo do processo de A', quem: 'B:leitura', metodo: 'GET', rota: (c) => `/legal/nay/cases/${c.nyCaso}/summary`, esperado: { status: 404, codigo: 'LEGAL_CASE_NOT_FOUND' } });
  await H({ id: 'JR-Y17', req: q('A0177'), titulo: 'Anônimo não usa a NAY Jurídica', quem: 'anonimo', metodo: 'POST', rota: '/legal/nay/deadline-suggestions', corpo: { text: 'x' }, esperado: { status: 401 } });
  await R.sqlTenant({
    id: 'JR-Y18', req: q('A0125', 'A0241', 'A0260', 'A0122', 'A0160'), quem: 'A:gestor', descricao: 'Retrato DEPOIS da NAY: nada mudou (prazos, versões, checklist, dossiês); só ai_runs registra as execuções',
    sql: `SELECT (SELECT count(*) FROM legal.legal_deadlines WHERE legal_case_id = :caso) AS prazos, (SELECT count(*) FROM legal.contract_versions WHERE contract_id = :ct) AS versoes,
            (SELECT string_agg(status, ',' ORDER BY id) FROM legal.contract_requirements WHERE contract_id = :ct) AS checklist, (SELECT count(*) FROM legal.evidence_packages WHERE legal_case_id = :caso) AS dossies,
            (SELECT count(*) FROM ai.ai_runs WHERE agent_name = 'NAY_JURIDICA' AND created_at > now() - interval '1 hour') AS execucoes_nay`,
    replacements: (c) => ({ caso: c.nyCaso, ct: c.nyContrato }),
    avaliar: (rows, c) => { const a = c.nyAntes; const d = rows[0]; return a && Number(d.prazos) === Number(a.prazos) && Number(d.versoes) === Number(a.versoes) && d.checklist === a.checklist && Number(d.dossies) === Number(a.dossies) && Number(d.execucoes_nay) >= 6; },
  });
};
