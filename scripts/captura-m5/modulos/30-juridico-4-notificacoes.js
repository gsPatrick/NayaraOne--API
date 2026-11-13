'use strict';
/**
 * Captura do fechamento do Marco 5 — Jurídico, notificações e revisão humana (Caderno M5 §13,
 * JUR-008, JUR-012). O envio exige MFA recente: a recusa real é capturada por HTTP e o envio é
 * provado pela camada de serviço no contexto do tenant (sem forjar MFA).
 */
const { q, sufixo, arquivo } = require('../juridico-apoio');

module.exports = async function juridicoNotificacoes(R) {
  const s = sufixo();
  const H = (o) => R.http(o);
  const notices = require('../../../src/modules/legal/contracts/application/notices.service');

  await H({ id: 'JR-N01', req: q('A0309'), titulo: 'Preparação: contrato de locação fictício', quem: 'A:gestor', metodo: 'POST', rota: '/legal/contracts', corpo: { contractType: 'LEASE_RESIDENTIAL', totalValue: 2500 }, esperado: { status: 201 }, guardar: (b, c) => { c.ntContrato = b.data.id; } });
  await H({ id: 'JR-N02', req: q('A0100'), titulo: 'Notificação sem canal válido é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/legal/notices', corpo: (c) => ({ contractId: c.ntContrato, channel: 'SINAL_DE_FUMACA', content: 'x' }), esperado: { status: 400, codigo: 'LEGAL_NOTICE_VALIDATION' } });
  await H({ id: 'JR-N03', req: q('A0100'), titulo: 'Notificação sem conteúdo nem arquivo é recusada', quem: 'A:gestor', metodo: 'POST', rota: '/legal/notices', corpo: (c) => ({ contractId: c.ntContrato, channel: 'EMAIL' }), esperado: { status: 400, codigo: 'LEGAL_NOTICE_VALIDATION' } });
  await H({
    id: 'JR-N04', req: q('A0100', 'A0101', 'A0305'), titulo: 'Rascunho de notificação extrajudicial feito pela IA (draftedByAi): canal, destinatário e conteúdo', quem: 'A:maker', metodo: 'POST', rota: '/legal/notices',
    corpo: (c) => ({ contractId: c.ntContrato, channel: 'POSTAL_MAIL', recipientDescription: 'Locatário fictício — Rua Exemplo, 100', content: `Notificação de atraso fictícia ${s}`, draftedByAi: true }),
    esperado: { status: 201 }, guardar: (b, c) => { c.ntAviso = b.data.id; },
  });
  await H({ id: 'JR-N05', req: q('A0177'), titulo: 'Perfil só de leitura não cria notificação', quem: 'A:leitura', metodo: 'POST', rota: '/legal/notices', corpo: (c) => ({ contractId: c.ntContrato, channel: 'EMAIL', content: 'x' }), esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-N06', req: q('A0101', 'A0305', 'A0175', 'A0274'), titulo: 'Rascunho da IA não pode ser aprovado direto do DRAFT (revisão humana obrigatória)', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/approve`, corpo: {}, esperado: { status: 409, codigo: 'LEGAL_NOTICE_REVIEW_REQUIRED' } });
  await H({ id: 'JR-N07', req: q('A0101'), titulo: 'Enviar sem aprovação: a rota exige MFA recente (recusa real)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/send`, corpo: {}, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });
  await R.servico({ id: 'JR-N08', req: q('A0101', 'A0305'), titulo: 'Enviar rascunho da IA ainda em DRAFT é bloqueado pela regra (camada de serviço)', chamada: 'notices.sendNotice(rascunho)', fn: (c) => R.comTenant('A:gestor', (tx, t) => notices.sendNotice(c.ntAviso, t.userId, tx)), esperado: { erro: 'LEGAL_NOTICE_SEND_BLOCKED' } });
  await H({ id: 'JR-N08b', req: q('A0172'), titulo: 'Nova versão do conteúdo sem motivo é recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/versions`, corpo: { content: 'Texto corrigido' }, esperado: { status: 400, codigo: 'LEGAL_NOTICE_VALIDATION' } });
  await H({ id: 'JR-N08c', req: q('A0172', 'A0100'), titulo: 'Corrigir o rascunho cria a VERSÃO 2 (a versão 1 fica preservada)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/versions`, corpo: { content: `Notificação de atraso fictícia ${s} — valor corrigido para R$ 2.500,00`, reason: 'Correção do valor em atraso' }, esperado: { status: 201 } });
  await H({ id: 'JR-N08d', req: q('A0172'), titulo: 'Leitura das versões da notificação (1 e 2, com SHA-256 de cada uma)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/notices/${c.ntAviso}/versions`, esperado: { status: 200 } });
  await H({ id: 'JR-N08e', req: q('A0177'), titulo: 'Maker (sem legal:update) não cria versão', quem: 'A:maker', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/versions`, corpo: { content: 'x', reason: 'x' }, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-N09', req: q('A0101'), titulo: 'Submete o rascunho à revisão humana', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/submit-for-review`, corpo: {}, esperado: { status: 200 } });
  await H({ id: 'JR-N10', req: q('A0177'), titulo: 'Maker (sem legal:approve) não aprova', quem: 'A:maker', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/approve`, corpo: {}, esperado: { status: 403, codigo: 'PERMISSION_DENIED' } });
  await H({ id: 'JR-N11', req: q('A0101', 'A0175', 'A0274'), titulo: 'Revisor humano (checker, legal:approve) aprova', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/approve`, corpo: {}, esperado: { status: 200 } });
  await H({ id: 'JR-N12', req: q('A0101'), titulo: 'Enviar aprovada: a rota continua exigindo MFA recente (recusa real)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/send`, corpo: {}, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });
  await R.servico({ id: 'JR-N13', req: q('A0100', 'A0101'), titulo: 'Envio da notificação aprovada (camada de serviço, o que a rota faz após o MFA): SENT com data e autor', chamada: 'notices.sendNotice(aprovada)', fn: (c) => R.comTenant('A:gestor', async (tx, t) => (await notices.sendNotice(c.ntAviso, t.userId, tx)).toJSON()), esperado: {} });
  await H({ id: 'JR-N14', req: q('A0100'), titulo: 'Evidência de entrega sem arquivo é recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/delivery-evidence`, corpo: {}, esperado: { status: 400, codigo: 'LEGAL_NOTICE_VALIDATION' } });
  await H({ id: 'JR-N14b', req: q('A0177', 'A0148'), titulo: 'Preparação: arquivo da empresa B', quem: 'B:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`ar-b-${s}.pdf`, `AR da empresa B ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.ntArB = b.data.id; } });
  await H({ id: 'JR-N14c', req: q('A0100', 'A0177'), titulo: 'Evidência de entrega com arquivo da empresa B é recusada (pentest M5)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/delivery-evidence`, corpo: (c) => ({ deliveryEvidenceFileId: c.ntArB }), esperado: { status: 400, codigo: 'LEGAL_NOTICE_FILE_NOT_FOUND' } });
  await H({ id: 'JR-N15', req: q('A0100'), titulo: 'Preparação: aviso de recebimento (AR) digitalizado', quem: 'A:gestor', metodo: 'POST', rota: '/files', corpo: arquivo(`ar-${s}.pdf`, `AR fictício ${s}`), esperado: { status: 201 }, guardar: (b, c) => { c.ntAr = b.data.id; } });
  await H({ id: 'JR-N16', req: q('A0100'), titulo: 'Registra a evidência de recebimento (DELIVERED)', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/delivery-evidence`, corpo: (c) => ({ deliveryEvidenceFileId: c.ntAr }), esperado: { status: 200 } });
  await H({ id: 'JR-N17', req: q('A0177'), titulo: 'Tenant B não lê a notificação de A', quem: 'B:gestor', metodo: 'GET', rota: (c) => `/legal/notices/${c.ntAviso}`, esperado: { status: 404, codigo: 'LEGAL_NOTICE_NOT_FOUND' } });
  await R.sqlTenant({
    id: 'JR-N18', req: q('A0100', 'A0101', 'A0305'), quem: 'A:leitura', descricao: 'Notificação: canal, destinatário, conteúdo, rascunho da IA, revisor humano, data de envio, data e evidência de recebimento',
    sql: 'SELECT channel, recipient_description, content IS NOT NULL AS tem_conteudo, drafted_by_ai, status, reviewed_by_user_id IS NOT NULL AS revisada_por_humano, reviewed_by_user_id <> created_by AS revisor_diferente_do_autor, sent_at::text AS sent_at, delivered_at::text AS delivered_at, delivery_evidence_file_id IS NOT NULL AS tem_evidencia FROM legal.notices WHERE id = :id',
    replacements: (c) => ({ id: c.ntAviso }),
    avaliar: (rows) => rows.length === 1 && rows[0].status === 'DELIVERED' && rows[0].drafted_by_ai && rows[0].revisada_por_humano && rows[0].sent_at && rows[0].delivered_at && rows[0].tem_evidencia,
  });
  await H({ id: 'JR-N19', req: q('A0309'), titulo: 'Linha do tempo do contrato inclui a notificação (JUR-012)', quem: 'A:leitura', metodo: 'GET', rota: (c) => `/legal/contracts/${c.ntContrato}/timeline`, esperado: { status: 200 }, guardar: (b, c) => { c.ntTimelineTipos = (b.data.items || []).map((i) => i.type); } });
  await R.servico({ id: 'JR-N20', req: q('A0309'), titulo: 'A linha do tempo devolvida tem o item NOTICE', chamada: 'conferência do corpo de JR-N19', fn: (c) => { if (!c.ntTimelineTipos.includes('NOTICE')) throw Object.assign(new Error('sem NOTICE'), { code: 'SEM_NOTICE' }); return { tipos: c.ntTimelineTipos }; }, esperado: {} });
  await H({ id: 'JR-N21', req: q('A0172'), titulo: 'Notificação enviada não muda mais: nova versão é recusada', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/notices/${c.ntAviso}/versions`, corpo: { content: 'v3', reason: 'depois do envio' }, esperado: { status: 409, codigo: 'LEGAL_NOTICE_VERSION_LOCKED' } });
  await R.sqlTenant({
    id: 'JR-N22', req: q('A0172', 'A0101'), quem: 'A:gestor', descricao: 'Versões gravadas (append-only): v1 e v2 com conteúdo e SHA-256 distintos e o motivo; a notificação saiu na versão aprovada (current = approved = 2)',
    sql: `SELECT v.version_number, v.content_sha256, v.reason, n.current_version, n.approved_version, n.status
          FROM legal.notice_versions v JOIN legal.notices n ON n.id = v.notice_id WHERE v.notice_id = :id ORDER BY v.version_number`,
    replacements: (c) => ({ id: c.ntAviso }),
    avaliar: (rows) => rows.length === 2 && rows[0].content_sha256 !== rows[1].content_sha256 && rows[1].reason === 'Correção do valor em atraso' && rows.every((r) => r.current_version === 2 && r.approved_version === 2 && r.status === 'DELIVERED'),
  });
  await R.sqlCatalogo({
    id: 'JR-N23', req: q('A0172'), descricao: 'legal.notice_versions tem o gatilho que recusa UPDATE e DELETE (append-only)',
    sql: "SELECT tgname FROM pg_trigger WHERE tgrelid = 'legal.notice_versions'::regclass AND NOT tgisinternal",
    avaliar: (rows) => rows.some((r) => r.tgname === 'notice_versions_append_only'),
  });
};
