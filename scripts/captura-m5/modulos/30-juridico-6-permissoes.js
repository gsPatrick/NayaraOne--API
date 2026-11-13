'use strict';
/**
 * Captura do fechamento do Marco 5 — Jurídico, RLS e permissões (Caderno M5 §19, DoD "RLS/permissões
 * verdes", JUR-TS-013 no que toca ao Jurídico). Fixtures próprias (o módulo roda sozinho).
 */
const { q, sufixo, futuro, arquivo } = require('../juridico-apoio');

const TABELAS = ['legal_cases', 'case_parties', 'legal_deadlines', 'evidence_packages', 'evidence_package_access_log', 'notices', 'notice_versions', 'case_receivables'];

module.exports = async function juridicoPermissoes(R) {
  const s = sufixo();
  const H = (o) => R.http(o);

  await H({ id: 'JR-R01', req: q('A0177'), titulo: 'Preparação: processo do tenant A', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: () => ({ caseType: 'LITIGATION', caseNumber: `RL-${s}`, responsibleUserId: R.claims['A:gestor'].userId }), esperado: { status: 201 }, guardar: (b, c) => { c.rlCaso = b.data.id; } });
  await H({ id: 'JR-R01b', req: q('A0177'), titulo: 'Preparação: arquivo de origem do prazo', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`origem-rls-${s}.pdf`, `Origem RLS ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.rlOrigem = b.data.id; } });
  await H({ id: 'JR-R02', req: q('A0177'), titulo: 'Preparação: prazo do tenant A', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.rlCaso}/deadlines`, corpo: (c) => ({ description: `Prazo RLS ${s}`, dueAt: futuro(9), sourceDocument: 'Intimação fictícia', sourceFileId: c.rlOrigem }), esperado: { status: 201 }, guardar: (b, c) => { c.rlPrazo = b.data.id; } });
  await H({ id: 'JR-R03', req: q('A0177'), titulo: 'Preparação: dossiê do tenant A', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.rlCaso}/evidence-packages`, corpo: { manifestItems: [{ type: 'NOTE', description: 'Nota RLS' }] }, esperado: { status: 201 }, guardar: (b, c) => { c.rlPacote = b.data.id; } });
  await H({ id: 'JR-R04', req: q('A0177', 'A0148'), titulo: 'Tenant B não lê o processo de A', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/legal/cases/${c.rlCaso}`, esperado: { status: 404, codigo: 'LEGAL_CASE_NOT_FOUND' } });
  await H({ id: 'JR-R05', req: q('A0177'), titulo: 'Tenant B não altera o processo de A', quem: 'B:gestor', metodo: 'PATCH', rota: (c) => `/legal/cases/${c.rlCaso}`, corpo: { summary: 'invasão' }, esperado: { status: 404, codigo: 'LEGAL_CASE_NOT_FOUND' } });
  await H({ id: 'JR-R06', req: q('A0177'), titulo: 'Tenant B não remarca o prazo de A', quem: 'B:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.rlPrazo}`, corpo: { dueAt: futuro(90), changeReason: 'invasão' }, esperado: { status: 404, codigo: 'LEGAL_DEADLINE_NOT_FOUND' } });
  await H({ id: 'JR-R07', req: q('A0177', 'A0148'), titulo: 'Tenant B não lê o dossiê de A', quem: 'B:leitura', metodo: 'GET', rota: (c) => `/legal/evidence-packages/${c.rlPacote}`, esperado: { status: 404, codigo: 'LEGAL_EVIDENCE_PACKAGE_NOT_FOUND' } });
  await H({ id: 'JR-R08', req: q('A0177'), titulo: 'Tenant B não põe o processo de A em legal hold', quem: 'B:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.rlCaso}/legal-hold`, corpo: { legalHold: true, reason: 'invasão' }, esperado: { status: 404, codigo: 'LEGAL_CASE_NOT_FOUND' } });
  await H({ id: 'JR-R09', req: q('A0177'), titulo: 'Tenant B lista prazos: nenhum de A aparece', quem: 'B:gestor', metodo: 'GET', rota: '/legal/deadlines', esperado: { status: 200 }, guardar: (b, c) => { c.rlListaB = (b.data || []).map((d) => d.id); } });
  await R.servico({ id: 'JR-R10', req: q('A0177'), titulo: 'A lista de prazos do tenant B não contém o prazo de A', chamada: 'conferência do corpo de JR-R09', fn: (c) => { if (c.rlListaB.includes(c.rlPrazo)) throw Object.assign(new Error('vazou'), { code: 'VAZOU' }); return { prazosDeB: c.rlListaB.length, contemPrazoDeA: false }; }, esperado: {} });
  await H({ id: 'JR-R11', req: q('A0177'), titulo: 'Leitura lê o processo; anônimo não', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/cases/${c.rlCaso}`, esperado: { status: 200 } });
  await H({ id: 'JR-R12', req: q('A0177'), titulo: 'Anônimo não lista prazos', quem: 'anonimo', metodo: 'GET', rota: '/legal/deadlines', esperado: { status: 401 } });
  await H({ id: 'JR-R13', req: q('A0177'), titulo: 'Maker (sem legal:update) não põe legal hold', quem: 'A:maker', metodo: 'POST', rota: (c) => `/legal/cases/${c.rlCaso}/legal-hold`, corpo: { legalHold: true, reason: 'x' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  // Pentest M5: ids de OUTRA empresa e objeto no lugar de texto/uuid.
  await H({ id: 'JR-R17', req: q('A0177'), titulo: 'Tenant B não grava processo com responsável/escalonamento que é usuário da empresa A', quem: 'B:gestor', metodo: 'POST', rota: '/legal/cases', corpo: () => ({ caseType: 'LITIGATION', responsibleUserId: R.claims['A:gestor'].userId, escalationUserId: R.claims['A:checker'].userId }), esperado: { status: 422, codigo: 'LEGAL_CASE_USER_NOT_IN_TENANT' } });
  await H({ id: 'JR-R18', req: q('A0177'), titulo: 'Tenant A também não aponta o escalonamento para usuário da empresa B (atualização)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/cases/${c.rlCaso}`, corpo: () => ({ escalationUserId: R.claims['B:gestor'].userId }), esperado: { status: 422, codigo: 'LEGAL_CASE_USER_NOT_IN_TENANT' } });
  await H({ id: 'JR-R19', req: q('A0177', 'A0148'), titulo: 'Preparação: arquivo da empresa B', quem: 'B:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`arquivo-b-${s}.pdf`, `Arquivo da empresa B ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.rlArquivoB = b.data.id; } });
  await H({ id: 'JR-R20', req: q('A0177', 'A0148', 'A0100'), titulo: 'Notificação da empresa A com arquivo da empresa B é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/legal/notices', corpo: (c) => ({ legalCaseId: c.rlCaso, channel: 'EMAIL', contentFileId: c.rlArquivoB }), esperado: { status: 400, codigo: 'LEGAL_NOTICE_FILE_NOT_FOUND' } });
  await H({ id: 'JR-R21', req: q('A0177'), titulo: 'Dossiê com objeto no lugar de texto/uuid ({"$gt":""}): 400, nunca 500', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.rlCaso}/evidence-package`, corpo: { manifestItems: [{ type: { $gt: '' }, description: { $gt: '' }, fileId: { $gt: '' }, hash: { $gt: '' } }] }, esperado: { status: 400, codigo: 'LEGAL_EVIDENCE_PACKAGE_VALIDATION' } });
  await H({ id: 'JR-R22', req: q('A0177'), titulo: 'Processo com status em objeto ({"$gt":""}): 400, nunca 500', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/cases/${c.rlCaso}`, corpo: { status: { $gt: '' } }, esperado: { status: 400, codigo: 'LEGAL_CASE_VALIDATION' } });
  await R.sqlTenant({
    id: 'JR-R14', req: q('A0177', 'A0148'), quem: 'B:gestor', descricao: 'RLS no banco: no contexto do tenant B, nenhuma linha de A aparece em processo, prazo e dossiê (SELECT direto pelo id)',
    sql: 'SELECT (SELECT count(*) FROM legal.legal_cases WHERE id = :caso) AS processos, (SELECT count(*) FROM legal.legal_deadlines WHERE id = :prazo) AS prazos, (SELECT count(*) FROM legal.evidence_packages WHERE id = :pacote) AS dossies',
    replacements: (c) => ({ caso: c.rlCaso, prazo: c.rlPrazo, pacote: c.rlPacote }),
    avaliar: (rows) => Number(rows[0].processos) === 0 && Number(rows[0].prazos) === 0 && Number(rows[0].dossies) === 0,
  });
  await R.sqlTenant({
    id: 'JR-R15', req: q('A0177'), quem: 'A:gestor', descricao: 'Controle positivo: no contexto do tenant A as mesmas linhas aparecem',
    sql: 'SELECT (SELECT count(*) FROM legal.legal_cases WHERE id = :caso) AS processos, (SELECT count(*) FROM legal.legal_deadlines WHERE id = :prazo) AS prazos, (SELECT count(*) FROM legal.evidence_packages WHERE id = :pacote) AS dossies',
    replacements: (c) => ({ caso: c.rlCaso, prazo: c.rlPrazo, pacote: c.rlPacote }),
    avaliar: (rows) => Number(rows[0].processos) === 1 && Number(rows[0].prazos) === 1 && Number(rows[0].dossies) === 1,
  });
  await R.sqlCatalogo({
    id: 'JR-R16', req: q('A0177', 'A0148'), descricao: 'Tabelas do Jurídico (processo, partes, prazo, dossiê, custódia, notificação) e people.file_links com RLS ligado e FORÇADO; a role da suíte não tem BYPASSRLS',
    sql: `SELECT n.nspname || '.' || c.relname AS tabela, c.relrowsecurity AS rls, c.relforcerowsecurity AS forcado
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE (n.nspname = 'legal' AND c.relname IN (${TABELAS.map((t) => `'${t}'`).join(', ')})) OR (n.nspname = 'people' AND c.relname = 'file_links') ORDER BY 1`,
    avaliar: (rows) => rows.length === TABELAS.length + 1 && rows.every((r) => r.rls && r.forcado),
  });
};
