'use strict';
/**
 * Captura do fechamento do Marco 5 — Jurídico, prazos (Caderno M5 §15, §19, JUR-009, JUR-TS-008/009,
 * Guia §12/§14). Caminho operacional por HTTP: CRIAR, ATRIBUIR, REMARCAR, CONCLUIR e REABRIR, com o
 * perfil que consegue e o recusado. O que só o job faz (alerta, ocorrência, escalonamento) e a
 * regra de "não responsável" (nenhum perfil do seed tem legal:update sem legal:approve) vão pela
 * camada de serviço no contexto do tenant.
 */
const { q, sufixo, arquivo, futuro, passado } = require('../juridico-apoio');

module.exports = async function juridicoPrazos(R) {
  const s = sufixo();
  const H = (o) => R.http(o);
  const uid = (quem) => R.claims[quem].userId;
  const legalDeadlines = require('../../../src/modules/legal/cases/deadline.service');
  const { processDeadlinesInTransaction } = require('../../../src/engines/jobs/legalDeadlineAlertJob');

  await H({ id: 'JR-D01', req: q('A0306'), titulo: 'Preparação: processo com responsável e escalonamento', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: () => ({ caseType: 'LITIGATION', caseNumber: `PZ-${s}`, responsibleUserId: uid('A:gestor'), escalationUserId: uid('A:checker') }), esperado: { status: 201 }, guardar: (b, c) => { c.pzCaso = b.data.id; } });
  const rota = (c) => `/legal/cases/${c.pzCaso}/deadlines`;
  await H({ id: 'JR-D01b', req: q('A0107', 'A0206'), titulo: 'Preparação: intimação de origem (arquivo íntegro da empresa, SHA-256 no upload)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`intimacao-${s}.pdf`, `Intimação fictícia ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.pzOrigem = b.data.id; } });
  const O = (c) => ({ sourceFileId: c.pzOrigem });
  // ---------- CRIAR ----------
  await H({ id: 'JR-D02', req: q('A0176', 'A0275', 'A0107', 'A0156', 'A0238', 'A0258', 'A0206', 'A0218'), titulo: 'CRIAR prazo crítico sem origem é bloqueado (JUR-TS-008)', quem: 'A:gestor', metodo: 'POST', rota, corpo: { description: 'Contestação', dueAt: futuro(15), criticality: 'CRITICAL', responsibleUserId: null }, esperado: { status: 400, codigo: 'DEADLINE_SOURCE_REQUIRED' } });
  await H({ id: 'JR-D03', req: q('A0107', 'A0156', 'A0206'), titulo: 'Origem só em TEXTO não basta (Guia §12: sourceFileId/sourceEventId)', quem: 'A:gestor', metodo: 'POST', rota, corpo: { description: 'Contestação', dueAt: futuro(15), criticality: 'CRITICAL', sourceDocument: 'Intimação fictícia (só texto)' }, esperado: { status: 400, codigo: 'DEADLINE_SOURCE_REQUIRED' } });
  await H({ id: 'JR-D03b', req: q('A0107', 'A0206'), titulo: 'Arquivo de origem inexistente é recusado', quem: 'A:gestor', metodo: 'POST', rota, corpo: { description: 'Contestação', dueAt: futuro(15), sourceFileId: '00000000-0000-4000-8000-000000000000' }, esperado: { status: 400, codigo: 'LEGAL_DEADLINE_SOURCE_NOT_FOUND' } });
  await H({
    id: 'JR-D04', req: q('A0107', 'A0108', 'A0306', 'A0218', 'A0173', 'A0271'), titulo: 'CRIAR prazo crítico com origem e responsável (gestor, legal:create)', quem: 'A:gestor', metodo: 'POST', rota,
    corpo: (c) => ({ description: `Contestação ${s}`, dueAt: futuro(15), criticality: 'CRITICAL', sourceDocument: 'Intimação fictícia DJe 03/11/2026', ...O(c), responsibleUserId: uid('A:maker') }), esperado: { status: 201 }, guardar: (b, c) => { c.pzCritico = b.data.id; },
  });
  await H({ id: 'JR-D05', req: q('A0218', 'A0177'), titulo: 'CRIAR por perfil só de leitura é recusado', quem: 'A:leitura', metodo: 'POST', rota, corpo: { description: 'x', dueAt: futuro(5), sourceDocument: 'x' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-D05p', req: q('A0148'), titulo: 'Preparação: arquivo avulso do gestor (sem vínculo, só o autor lê)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`avulso-${s}.pdf`, `Arquivo avulso ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.pzAvulso = b.data.id; } });
  await H({ id: 'JR-D05a', req: q('A0206', 'A0148'), titulo: 'Arquivo de origem que o ator não pode ler não é vinculado (guarda de vínculo de arquivo): o maker tem legal:create, mas não lê o arquivo avulso do gestor', quem: 'A:maker', metodo: 'POST', rota, corpo: (c) => ({ description: 'x', dueAt: futuro(5), sourceFileId: c.pzAvulso }), esperado: { status: 403, codigo: 'FILE_ATTACH_FORBIDDEN' } });
  await R.sqlTenant({
    id: 'JR-D05b', req: q('A0206'), quem: 'A:gestor', descricao: 'Preparação: id de um evento real da empresa (legal.case.created do processo no outbox) para servir de origem',
    sql: "SELECT id FROM integration.outbox_events WHERE aggregate_id = :id AND event_type = 'legal.case.created'",
    replacements: (c) => ({ id: c.pzCaso }),
    avaliar: (rows, c) => { c.pzEvento = rows[0] && rows[0].id; return rows.length === 1; },
  });
  await H({ id: 'JR-D06', req: q('A0218', 'A0108'), titulo: 'CRIAR pelo maker (legal:create): prazo MEDIUM sem responsável próprio (vale o do processo), só com a data (vence 23:59 de Brasília) e origem por EVENTO real', quem: 'A:maker', metodo: 'POST', rota, corpo: (c) => ({ description: `Réplica ${s}`, dueAt: '2030-01-01', sourceEventId: c.pzEvento, sourceEvent: 'Juntada de contestação (evento fictício)' }), esperado: { status: 201 }, guardar: (b, c) => { c.pzMedio = b.data.id; } });
  await H({ id: 'JR-D07', req: q('A0218', 'A0177'), titulo: 'Tenant B não cria prazo no processo de A', quem: 'B:gestor', metodo: 'POST', rota, corpo: (c) => ({ description: 'x', dueAt: futuro(5), ...O(c) }), esperado: { status: 404, codigo: 'LEGAL_CASE_NOT_FOUND' } });
  await H({ id: 'JR-D08', req: q('A0306'), titulo: 'Preparação: processo sem responsável e sem escalonamento', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: { caseType: 'CONSULTATIVE' }, esperado: { status: 201 }, guardar: (b, c) => { c.pzCasoSemResp = b.data.id; } });
  await H({ id: 'JR-D09', req: q('A0306', 'A0108'), titulo: 'Prazo vencido sem responsável (processo sem responsável): recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.pzCasoSemResp}/deadlines`, corpo: (c) => ({ description: 'x', dueAt: passado(1), ...O(c) }), esperado: { status: 400, codigo: 'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED' } });
  await H({ id: 'JR-D09b', req: q('A0108', 'A0306'), titulo: 'Prazo futuro sem responsável próprio em processo sem responsável: recusado (todo prazo tem responsável)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.pzCasoSemResp}/deadlines`, corpo: (c) => ({ description: 'x', dueAt: futuro(9), ...O(c) }), esperado: { status: 400, codigo: 'LEGAL_DEADLINE_RESPONSIBLE_REQUIRED' } });
  await H({ id: 'JR-D10', req: q('A0306'), titulo: 'Crítico em processo sem escalonamento: recusado (JUR-009)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.pzCasoSemResp}/deadlines`, corpo: (c) => ({ description: 'x', dueAt: futuro(5), ...O(c), criticality: 'CRITICAL', responsibleUserId: uid('A:maker') }), esperado: { status: 422, codigo: 'LEGAL_DEADLINE_CRITICAL_ESCALATION_REQUIRED' } });
  await R.sqlTenant({
    id: 'JR-D11', req: q('A0107', 'A0108', 'A0306'), quem: 'A:leitura', descricao: 'Prazos gravados: origem verificável (arquivo ou evento), due_at no fuso de São Paulo ("2030-01-01" = 23:59 de Brasília), criticidade, responsável e a TAREFA do responsável (Guia §12)',
    sql: `SELECT d.description, d.source_file_id IS NOT NULL AS origem_arquivo, d.source_event_type, d.source_document, d.due_at::text AS due_at_utc, to_char(d.due_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') AS due_at_sao_paulo,
            d.criticality, d.responsible_user_id IS NOT NULL AS tem_responsavel_proprio, d.status, t.related_entity_type AS tarefa_tipo, t.status AS tarefa_status, t.priority AS tarefa_prioridade,
            t.assigned_to_user_id = COALESCE(d.responsible_user_id, c.responsible_user_id) AS tarefa_do_responsavel, t.due_at = d.due_at AS tarefa_mesmo_vencimento
          FROM legal.legal_deadlines d JOIN legal.legal_cases c ON c.id = d.legal_case_id LEFT JOIN core.tasks t ON t.id = d.task_id WHERE d.legal_case_id = :id ORDER BY d.created_at`,
    replacements: (c) => ({ id: c.pzCaso }),
    avaliar: (rows) => rows.length === 2 && rows.every((r) => (r.origem_arquivo || r.source_event_type) && r.tarefa_tipo === 'LEGAL_DEADLINE' && r.tarefa_status === 'OPEN' && r.tarefa_do_responsavel && r.tarefa_mesmo_vencimento) && rows.some((r) => r.due_at_sao_paulo === '2030-01-01 23:59' && r.source_event_type === 'OUTBOX_EVENT'),
  });
  // ---------- ATRIBUIR ----------
  await H({ id: 'JR-D12', req: q('A0108', 'A0306'), titulo: 'ATRIBUIR responsável ao prazo (gestor, legal:update)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzMedio}`, corpo: () => ({ responsibleUserId: uid('A:maker'), changeReason: 'Distribuição ao advogado' }), esperado: { status: 200 } });
  await H({ id: 'JR-D13', req: q('A0177'), titulo: 'ATRIBUIR pelo maker (sem legal:update) é recusado', quem: 'A:maker', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzMedio}`, corpo: () => ({ responsibleUserId: uid('A:maker') }), esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-D14', req: q('A0108'), titulo: 'ATRIBUIR a usuário sem vínculo com a empresa é recusado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzMedio}`, corpo: () => ({ responsibleUserId: uid('B:gestor') }), esperado: { status: 422, codigo: 'LEGAL_DEADLINE_RESPONSIBLE_NOT_IN_TENANT' } });
  // ---------- REMARCAR ----------
  await H({ id: 'JR-D15', req: q('A0112'), titulo: 'REMARCAR sem justificativa é recusado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { dueAt: futuro(20) }, esperado: { status: 400, codigo: 'LEGAL_DEADLINE_CHANGE_REASON_REQUIRED' } });
  await H({ id: 'JR-D16', req: q('A0112'), titulo: 'REMARCAR com justificativa', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { dueAt: futuro(20), changeReason: 'Prorrogação deferida pelo juízo (fictício)' }, esperado: { status: 200 } });
  await H({ id: 'JR-D17', req: q('A0112', 'A0177'), titulo: 'REMARCAR pelo checker (sem legal:update) é recusado', quem: 'A:checker', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { dueAt: futuro(25), changeReason: 'tentativa' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.sqlTenant({
    id: 'JR-D18', req: q('A0112'), quem: 'A:gestor', descricao: 'Histórico da remarcação: vencimento anterior (before_json) preservado com a justificativa e o autor',
    sql: "SELECT before_json->>'dueAt' AS vencimento_anterior, after_json->>'dueAt' AS vencimento_novo, reason, user_id IS NOT NULL AS tem_autor FROM audit.audit_log WHERE entity_type = 'LegalDeadline' AND entity_id = :id AND action = 'legal.deadline.update' ORDER BY occurred_at",
    replacements: (c) => ({ id: c.pzCritico }),
    avaliar: (rows) => rows.some((r) => r.reason === 'Prorrogação deferida pelo juízo (fictício)' && r.vencimento_anterior && r.vencimento_anterior !== r.vencimento_novo && r.tem_autor),
  });
  // ---------- CONCLUIR ----------
  await H({ id: 'JR-D19', req: q('A0111', 'A0146'), titulo: 'CONCLUIR sem evidência nem nota é recusado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'DONE' }, esperado: { status: 422, codigo: 'LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED' } });
  await H({ id: 'JR-D20', req: q('A0111', 'A0146'), titulo: 'CONCLUIR com nota só de espaços é recusado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'DONE', conclusionNote: '   ' }, esperado: { status: 422, codigo: 'LEGAL_DEADLINE_CONCLUSION_PROOF_REQUIRED' } });
  await H({ id: 'JR-D21', req: q('A0146', 'A0177'), titulo: 'CONCLUIR pelo maker, mesmo sendo o responsável, sem legal:update: recusado', quem: 'A:maker', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'DONE', conclusionNote: 'Protocolado' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-D22', req: q('A0146'), titulo: 'CONCLUIR por leitura: recusado', quem: 'A:leitura', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'DONE', conclusionNote: 'Protocolado' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.servico({
    id: 'JR-D23', req: q('A0146'), titulo: 'CONCLUIR por quem tem legal:update mas não é o responsável nem tem legal:approve (checker como ator, permissões sem legal:approve): recusado',
    chamada: "legalDeadlines.updateLegalDeadline(prazo, {status:'DONE', conclusionNote}, checker, tx, {actorPermissions:['legal:read','legal:update']})",
    fn: (c) => R.comTenant('A:gestor', (tx) => legalDeadlines.updateLegalDeadline(c.pzCritico, { status: 'DONE', conclusionNote: 'Protocolado' }, uid('A:checker'), tx, { actorPermissions: ['legal:read', 'legal:update'] })),
    esperado: { erro: 'LEGAL_DEADLINE_NOT_RESPONSIBLE' },
  });
  await H({ id: 'JR-D24', req: q('A0111', 'A0113'), titulo: 'Preparação: comprovante de protocolo (arquivo fictício)', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`protocolo-${s}.pdf`, `Protocolo fictício ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.pzProva = b.data.id; } });
  await H({ id: 'JR-D25', req: q('A0111'), titulo: 'CONCLUIR com evidência inexistente é recusado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'DONE', conclusionEvidenceFileId: '00000000-0000-4000-8000-000000000000' }, esperado: { status: 400, codigo: 'LEGAL_DEADLINE_EVIDENCE_FILE_NOT_FOUND' } });
  await H({ id: 'JR-D26', req: q('A0111', 'A0146', 'A0173'), titulo: 'CONCLUIR com evidência pelo gestor (legal:update + legal:approve)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: (c) => ({ status: 'DONE', conclusionEvidenceFileId: c.pzProva, conclusionNote: 'Contestação protocolada.' }), esperado: { status: 200 } });
  await R.servico({
    id: 'JR-D27', req: q('A0146'), titulo: 'CONCLUIR pelo próprio responsável (maker como ator, com legal:update e sem legal:approve): aceito',
    chamada: "legalDeadlines.updateLegalDeadline(prazoMedio, {status:'DONE', conclusionNote}, maker, tx, {actorPermissions:['legal:read','legal:update']})",
    fn: (c) => R.comTenant('A:gestor', async (tx) => (await legalDeadlines.updateLegalDeadline(c.pzMedio, { status: 'DONE', conclusionNote: 'Réplica protocolada.' }, uid('A:maker'), tx, { actorPermissions: ['legal:read', 'legal:update'] })).toJSON()),
    esperado: {},
  });
  await H({ id: 'JR-D28', req: q('A0177'), titulo: 'Tenant B não conclui prazo de A', quem: 'B:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'DONE', conclusionNote: 'x' }, esperado: { status: 404, codigo: 'LEGAL_DEADLINE_NOT_FOUND' } });
  // ---------- REABRIR ----------
  await H({ id: 'JR-D29', req: q('A0306', 'A0177'), titulo: 'REABRIR pelo checker (sem legal:update): recusado', quem: 'A:checker', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'PENDING' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-D30', req: q('A0306'), titulo: 'REABRIR crítico concluído (gestor, legal:update): processo com responsável e escalonamento, ciclo de alerta reiniciado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico}`, corpo: { status: 'PENDING' }, esperado: { status: 200 } });
  await H({ id: 'JR-D31a', req: q('A0306'), titulo: 'Preparação: processo só com escalonamento (sem responsável próprio)', quem: 'A:gestor', metodo: 'POST', rota: '/legal/cases', corpo: () => ({ caseType: 'LITIGATION', escalationUserId: uid('A:checker') }), esperado: { status: 201 }, guardar: (b, c) => { c.pzCasoEsc = b.data.id; } });
  await H({ id: 'JR-D31b', req: q('A0306'), titulo: 'Preparação: prazo crítico com responsável próprio nesse processo', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/cases/${c.pzCasoEsc}/deadlines`, corpo: (c) => ({ description: `Embargos ${s}`, dueAt: futuro(10), criticality: 'CRITICAL', sourceDocument: 'Sentença fictícia', ...O(c), responsibleUserId: uid('A:maker') }), esperado: { status: 201 }, guardar: (b, c) => { c.pzCritico2 = b.data.id; } });
  await H({ id: 'JR-D31c', req: q('A0306', 'A0111'), titulo: 'Preparação: conclui o prazo crítico com nota', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico2}`, corpo: { status: 'DONE', conclusionNote: 'Embargos opostos.' }, esperado: { status: 200 } });
  await H({ id: 'JR-D31d', req: q('A0306'), titulo: 'REABRIR crítico retirando o único responsável efetivo: recusado e estado preservado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico2}`, corpo: { status: 'PENDING', responsibleUserId: null }, esperado: { status: 422, codigo: 'LEGAL_DEADLINE_CRITICAL_RESPONSIBLE_REQUIRED' } });
  await H({ id: 'JR-D31e', req: q('A0306'), titulo: 'REABRIR o mesmo crítico mantendo o responsável: aceito', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCritico2}`, corpo: { status: 'PENDING' }, esperado: { status: 200 } });
  await H({ id: 'JR-D32', req: q('A0108', 'A0173'), titulo: 'Lista os prazos do processo com severidade calculada', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/deadlines?legalCaseId=${c.pzCaso}`, esperado: { status: 200 } });

  // ---------- CANCELAR (com motivo; terminal) e tarefa sincronizada ----------
  await H({ id: 'JR-D32b', req: q('A0206'), titulo: 'Preparação: prazo que será cancelado', quem: 'A:gestor', metodo: 'POST', rota, corpo: (c) => ({ description: `Audiência ${s}`, dueAt: futuro(12), ...O(c) }), esperado: { status: 201 }, guardar: (b, c) => { c.pzCancel = b.data.id; } });
  await H({ id: 'JR-D32c', req: q('A0206'), titulo: 'CANCELAR sem motivo é recusado', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCancel}`, corpo: { status: 'CANCELLED' }, esperado: { status: 400, codigo: 'LEGAL_DEADLINE_CANCEL_REASON_REQUIRED' } });
  await H({ id: 'JR-D32d', req: q('A0177'), titulo: 'CANCELAR pelo checker (sem legal:update) é recusado', quem: 'A:checker', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCancel}`, corpo: { status: 'CANCELLED', changeReason: 'Audiência cancelada pelo juízo' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await R.servico({
    id: 'JR-D32e', req: q('A0206'), titulo: 'CANCELAR por quem tem legal:update mas não legal:approve é recusado (regra conservadora registrada)',
    chamada: "legalDeadlines.updateLegalDeadline(prazo, {status:'CANCELLED', changeReason}, maker, tx, {actorPermissions:['legal:read','legal:update']})",
    fn: (c) => R.comTenant('A:gestor', (tx) => legalDeadlines.updateLegalDeadline(c.pzCancel, { status: 'CANCELLED', changeReason: 'Audiência cancelada pelo juízo' }, uid('A:maker'), tx, { actorPermissions: ['legal:read', 'legal:update'] })),
    esperado: { erro: 'LEGAL_DEADLINE_CANCEL_NOT_ALLOWED' },
  });
  await H({ id: 'JR-D32f', req: q('A0206'), titulo: 'CANCELAR com motivo (gestor, legal:approve)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCancel}`, corpo: { status: 'CANCELLED', changeReason: 'Audiência cancelada pelo juízo' }, esperado: { status: 200 } });
  await H({ id: 'JR-D32g', req: q('A0206'), titulo: 'Prazo cancelado não reabre (estado terminal)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/deadlines/${c.pzCancel}`, corpo: { status: 'PENDING' }, esperado: { status: 409, codigo: 'LEGAL_DEADLINE_INVALID_TRANSITION' } });
  await R.sqlTenant({
    id: 'JR-D32h', req: q('A0206', 'A0173', 'A0271'), quem: 'A:gestor', descricao: 'Tarefa acompanha o prazo (Guia §12): reaberto = OPEN, concluído = DONE, cancelado = CANCELLED; remarcado = mesmo vencimento; reatribuído = novo responsável',
    sql: `SELECT d.description, d.status, d.cancel_reason, t.status AS tarefa_status, t.due_at = d.due_at AS mesmo_vencimento,
            t.assigned_to_user_id = COALESCE(d.responsible_user_id, c.responsible_user_id) AS do_responsavel
          FROM legal.legal_deadlines d JOIN legal.legal_cases c ON c.id = d.legal_case_id JOIN core.tasks t ON t.id = d.task_id WHERE d.id IN (:a, :b, :c) ORDER BY d.created_at`,
    replacements: (c) => ({ a: c.pzCritico, b: c.pzMedio, c: c.pzCancel }),
    avaliar: (rows) => rows.length === 3 && rows.every((r) => r.mesmo_vencimento && r.do_responsavel && r.tarefa_status === ({ PENDING: 'OPEN', DONE: 'DONE', CANCELLED: 'CANCELLED' })[r.status]) && rows.some((r) => r.status === 'CANCELLED' && r.cancel_reason),
  });

  // ---------- VENCIDO: alerta, ocorrência, evento e escalonamento (job) ----------
  await H({ id: 'JR-D33', req: q('A0110', 'A0157'), titulo: 'Prazo crítico que já nasce vencido, com responsável', quem: 'A:gestor', metodo: 'POST', rota, corpo: (c) => ({ description: `Recurso ${s}`, dueAt: passado(2), criticality: 'CRITICAL', sourceDocument: 'Acórdão fictício', ...O(c), responsibleUserId: uid('A:maker') }), esperado: { status: 201 }, guardar: (b, c) => { c.pzVencido = b.data.id; } });
  const agora = new Date();
  await R.servico({ id: 'JR-D34', req: q('A0109', 'A0110', 'A0140', 'A0157', 'A0230'), titulo: 'Job de prazos (relógio de agora): alerta OVERDUE, ocorrência CRITICAL e legal.deadline.overdue', chamada: 'processDeadlinesInTransaction(tx, agora)', fn: () => R.comTenant('A:gestor', (tx) => processDeadlinesInTransaction(tx, agora)), esperado: {} });
  await R.servico({ id: 'JR-D35', req: q('A0109', 'A0157'), titulo: 'Job de novo 25 h depois sem conclusão: escala para o usuário de escalonamento', chamada: 'processDeadlinesInTransaction(tx, agora + 25h)', fn: () => R.comTenant('A:gestor', (tx) => processDeadlinesInTransaction(tx, new Date(agora.getTime() + 25 * 3600000))), esperado: {} });
  await R.sqlTenant({
    id: 'JR-D36', req: q('A0176', 'A0275', 'A0109', 'A0110', 'A0140', 'A0157', 'A0230', 'A0139', 'A0229', 'A0273'), quem: 'A:gestor', descricao: 'Prazo vencido: severidade alertada, ocorrência CRITICAL única, escalonado, eventos legal.deadline.created e legal.deadline.overdue (uma vez) e notificações ao responsável e ao escalonamento',
    sql: `SELECT d.last_alerted_severity, d.escalated_at IS NOT NULL AS escalado, d.status,
            (SELECT count(*) FROM core.tasks t WHERE t.related_entity_type = 'legal.legal_deadlines' AND t.related_entity_id = d.id AND t.priority = 'CRITICAL') AS ocorrencias,
            (SELECT count(*) FROM integration.outbox_events o WHERE o.aggregate_id = d.id AND o.event_type = 'legal.deadline.overdue') AS eventos_overdue,
            (SELECT count(*) FROM integration.outbox_events o WHERE o.aggregate_id = d.id AND o.event_type = 'legal.deadline.created') AS eventos_created,
            (SELECT count(*) FROM core.notifications n WHERE n.user_id = :resp AND n.title = 'Prazo jurídico VENCIDO' AND n.body LIKE '%' || d.description || '%') AS avisos_responsavel,
            (SELECT count(*) FROM core.notifications n WHERE n.user_id = :esc AND n.body LIKE '%' || d.description || '%') AS avisos_escalonamento
          FROM legal.legal_deadlines d WHERE d.id = :id`,
    replacements: (c) => ({ id: c.pzVencido, resp: uid('A:maker'), esc: uid('A:checker') }),
    avaliar: (rows) => rows.length === 1 && rows[0].last_alerted_severity === 'OVERDUE' && rows[0].escalado && rows[0].status === 'PENDING' && Number(rows[0].ocorrencias) === 1 && Number(rows[0].eventos_overdue) === 1 && Number(rows[0].eventos_created) === 1 && Number(rows[0].avisos_responsavel) === 1 && Number(rows[0].avisos_escalonamento) === 1,
  });
};
