'use strict';
/**
 * Captura do fechamento do Marco 5 — Contratos: do SIGNING ao CLOSED (Caderno §5, §8, §18; Guia §3,
 * §8 webhook; JUR-TS-002/007). Continua o contrato `ctCic` do módulo 11 (mesmo processo da captura).
 */
module.exports = async function contratosCicloAssinatura(R) {
  const H = (o) => R.http(o);
  const sig = (c, i) => c.ctCicSigs[i].ext;

  await H({ id: 'CT-201', req: ['M5-A0150-1427b1', 'M5-A0233-5d1840', 'M5-A0302-11ebaa'], titulo: 'JUR-TS-002: webhook com hash diferente do da versão é rejeitado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/signatures/${sig(c, 0)}/webhook`, corpo: { contentHash: 'ab'.repeat(32) }, esperado: { status: 409, codigo: 'LEGAL_SIGNATURE_HASH_MISMATCH' } });
  await H({ id: 'CT-202', req: ['M5-A0070-aa260b', 'M5-A0254-adf071'], titulo: 'Webhook de laboratório sem o hash do documento assinado é recusado', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/signatures/${sig(c, 0)}/webhook`, corpo: {}, esperado: { status: 400, codigo: 'LEGAL_WEBHOOK_HASH_REQUIRED' } });
  await H({ id: 'CT-203', req: ['M5-A0070-aa260b'], titulo: 'Callback forjado (id externo inexistente) não cria nem altera nada', quem: 'A:gestor', metodo: 'POST', rota: '/legal/signatures/forjado-inexistente/webhook', corpo: (c) => ({ contentHash: c.ctCicHash }), esperado: { status: 404, codigo: 'LEGAL_SIGNATURE_NOT_FOUND' } });
  await H({ id: 'CT-204', req: ['M5-A0070-aa260b', 'M5-A0201-67738d'], titulo: 'Webhook público do provedor sem assinatura válida: 401, igual para signatário existente ou não (sem oráculo)', quem: 'anonimo', metodo: 'POST', rota: '/legal/webhooks/clicksign', corpo: { event: { name: 'sign', data: { signer: { key: 'chave-desconhecida' } } } }, esperado: { status: 401, codigo: 'LEGAL_WEBHOOK_HMAC_INVALID' } });
  await H({ id: 'CT-204b', req: ['M5-A0070-aa260b'], titulo: 'Mesmo webhook sem HMAC para um signatário EXISTENTE: mesma resposta 401', quem: 'anonimo', metodo: 'POST', rota: '/legal/webhooks/clicksign', corpo: (c) => ({ event: { name: 'sign', data: { signer: { key: c.ctCicSigs[1].ext } } } }), esperado: { status: 401, codigo: 'LEGAL_WEBHOOK_HMAC_INVALID' } });
  await H({ id: 'CT-205', req: ['M5-A0070-aa260b', 'M5-A0069-ea344f'], titulo: 'Primeira assinatura confirmada com o hash da versão', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/signatures/${sig(c, 0)}/webhook`, corpo: (c) => ({ contentHash: c.ctCicHash }), esperado: { status: 200 } });
  await R.sqlTenant({ id: 'CT-206', req: ['M5-A0073-185af0'], quem: 'A:leitura', descricao: 'Com 1 de 2 assinaturas obrigatórias o contrato continua em SIGNING', sql: 'SELECT status FROM legal.contracts WHERE id = :id', replacements: (c) => ({ id: c.ctCic }), avaliar: (r) => r[0].status === 'SIGNING' });
  await H({ id: 'CT-207', req: ['M5-A0155-f65cd8', 'M5-A0236-cf6596', 'M5-A0167-e05f18', 'M5-A0266-f06596', 'M5-A0070-aa260b'], titulo: 'JUR-TS-007: o MESMO webhook (mesmo id externo) repetido não reaplica efeito', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/signatures/${sig(c, 0)}/webhook`, corpo: (c) => ({ contentHash: c.ctCicHash }), esperado: { status: 200 }, guardar: (b, c) => { c.ctDupOk = b && b.data && b.data.alreadyProcessed === true; } });
  await R.sqlTenant({
    id: 'CT-208', req: ['M5-A0155-f65cd8', 'M5-A0236-cf6596'], quem: 'A:leitura', descricao: 'Webhook duplicado = uma única atualização: 1 auditoria e 1 evento legal.signature.signed para a assinatura',
    sql: "SELECT (SELECT count(*)::int FROM audit.audit_log WHERE entity_id = s.id AND action = 'legal.signature.signed') AS auditorias, (SELECT count(*)::int FROM integration.outbox_events WHERE aggregate_id = s.id AND event_type = 'legal.signature.signed') AS eventos, s.status FROM legal.signatures s WHERE s.external_signature_id = :ext",
    replacements: (c) => ({ ext: sig(c, 0) }), avaliar: (r, c) => c.ctDupOk && r[0].auditorias === 1 && r[0].eventos === 1 && r[0].status === 'SIGNED',
  });
  await H({ id: 'CT-209', req: ['M5-A0073-185af0', 'M5-A0056-103e8b'], titulo: 'Forçar SIGNED pela transição com assinatura obrigatória pendente é bloqueado', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/transition`, corpo: { targetStatus: 'SIGNED' }, esperado: { status: 409, codigo: 'LEGAL_CONTRACT_SIGNATURE_GATE' } });
  await H({ id: 'CT-210', req: ['M5-A0056-103e8b', 'M5-A0073-185af0', 'M5-A0130-37a2d4', 'M5-A0223-1ad197'], titulo: 'Última assinatura obrigatória da versão: contrato vira SIGNED automaticamente', quem: 'A:gestor', metodo: 'POST', rota: (c) => `/legal/signatures/${sig(c, 1)}/webhook`, corpo: (c) => ({ contentHash: c.ctCicHash }), esperado: { status: 200 } });
  await R.sqlTenant({ id: 'CT-211', req: ['M5-A0056-103e8b', 'M5-A0130-37a2d4', 'M5-A0223-1ad197'], quem: 'A:leitura', descricao: 'Contrato SIGNED e evento contract.signed com a versão e o hash assinados', sql: "SELECT c.status, e.payload_json->>'contractVersionId' AS versao, e.payload_json->>'contentHash' AS hash FROM legal.contracts c LEFT JOIN integration.outbox_events e ON e.aggregate_id = c.id AND e.event_type = 'contract.signed' WHERE c.id = :id", replacements: (c) => ({ id: c.ctCic }), avaliar: (r, c) => r.length === 1 && r[0].status === 'SIGNED' && r[0].versao === c.ctCicV1 && r[0].hash === c.ctCicHash });

  await H({ id: 'CT-212', req: ['M5-A0057-c754d9', 'M5-A0131-5fe3f9', 'M5-A0224-560396'], titulo: 'SIGNED -> ACTIVE (gate de ativação reconfere documento e assinaturas)', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/transition`, corpo: { targetStatus: 'ACTIVE' }, esperado: { status: 200 } });
  await R.sqlTenant({ id: 'CT-213', req: ['M5-A0131-5fe3f9', 'M5-A0224-560396'], quem: 'A:leitura', descricao: 'Evento contract.activated publicado', sql: "SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = :id AND event_type = 'contract.activated'", replacements: (c) => ({ id: c.ctCic }), avaliar: (r) => r[0].n === 1 });

  await H({ id: 'CT-214', req: ['M5-A0299-827218'], titulo: 'Correção de dados do contrato ativo exige MFA recente (recusa real sem MFA)', quem: 'A:gestor', metodo: 'PATCH', rota: (c) => `/legal/contracts/${c.ctCic}/correct`, corpo: { reason: 'tentativa', totalValue: 9999 }, esperado: { status: 403, codigo: 'MFA_REQUIRED_NOT_ENABLED' } });
  await R.servico({
    id: 'CT-215', req: ['M5-A0299-827218', 'M5-A0253-8388d0'], titulo: 'JUR-001: mesmo com MFA (camada de serviço), valor do contrato ATIVO não é reescrito — a alteração é por aditivo', chamada: 'contractsService.correctContractData(contratoAtivo, { totalValue: 9999, reason })',
    fn: (c) => R.comTenant('A:gestor', (tx, t) => require('../../../src/modules/legal/contracts/application/contract.service').correctContractData(c.ctCic, { totalValue: 9999, reason: 'Tentativa fictícia da captura (JUR-001)' }, t.userId, tx).then((ct) => ({ status: ct.status, totalValue: ct.totalValue }))),
    esperado: { erro: 'LEGAL_CONTRACT_TERMS_LOCKED_USE_ADDENDUM' },
  });

  await H({ id: 'CT-216', req: ['M5-A0058-6ae767'], titulo: 'Suspender sem motivo é recusado', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/suspend`, corpo: {}, esperado: { status: 400, codigo: 'LEGAL_CONTRACT_TRANSITION_REASON_REQUIRED' } });
  await H({ id: 'CT-217', req: ['M5-A0058-6ae767', 'M5-A0196-8a7471'], titulo: 'ACTIVE -> SUSPENDED com motivo', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/suspend`, corpo: { reason: 'Suspensão fictícia da captura' }, esperado: { status: 200 } });
  await H({ id: 'CT-218', req: ['M5-A0058-6ae767', 'M5-A0196-8a7471'], titulo: 'SUSPENDED -> ACTIVE (reativação) com motivo', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/reactivate`, corpo: { reason: 'Causa sanada (fictícia)' }, esperado: { status: 200 } });
  await H({ id: 'CT-219', req: ['M5-A0059-0f891e'], titulo: 'Impacto da rescisão calculado pelo servidor (sem impedimentos)', quem: 'A:checker', metodo: 'GET', rota: (c) => `/legal/contracts/${c.ctCic}/impact`, esperado: { status: 200 }, guardar: (b, c, passo) => { c.ctImpacto = { token: b.data.impactToken, code: b.data.record.code, min: b.data.confirm.justificationMin, bloqueios: b.data.blockers.length }; passo.corpo.data.impactToken = '[REDACTED]'; } });
  await H({
    id: 'CT-220', req: ['M5-A0059-0f891e', 'M5-A0132-460251', 'M5-A0196-8a7471'], titulo: 'ACTIVE -> TERMINATED com confirmação crítica (código digitado e justificativa)', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/terminate`,
    corpo: (c) => ({ reason: 'Rescisão fictícia da captura da matriz M5', confirmation: { typedCode: c.ctImpacto.code, justification: 'Rescisão fictícia da captura da matriz do Marco 5, sem efeito real.'.padEnd(Math.max(c.ctImpacto.min || 0, 10), '.'), impactToken: c.ctImpacto.token } }),
    esperado: { status: 200 }, guardar: (b, c, passo) => { passo.corpoEnviado.confirmation.impactToken = '[REDACTED]'; },
  });
  await R.sqlTenant({ id: 'CT-221', req: ['M5-A0132-460251'], quem: 'A:leitura', descricao: 'Evento contract.terminated publicado', sql: "SELECT count(*)::int AS n FROM integration.outbox_events WHERE aggregate_id = :id AND event_type = 'contract.terminated'", replacements: (c) => ({ id: c.ctCic }), avaliar: (r) => r[0].n === 1 });
  await H({ id: 'CT-222', req: ['M5-A0060-eea580', 'M5-A0196-8a7471'], titulo: 'TERMINATED -> CLOSED (arquivado operacionalmente)', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/close`, corpo: { reason: 'Arquivamento fictício' }, esperado: { status: 200 } });
  await H({ id: 'CT-223', req: ['M5-A0197-0e0edb', 'M5-A0060-eea580'], titulo: 'De CLOSED não há transição', quem: 'A:checker', metodo: 'POST', rota: (c) => `/legal/contracts/${c.ctCic}/transition`, corpo: { targetStatus: 'ACTIVE' }, esperado: { status: 409, codigo: 'LEGAL_CONTRACT_INVALID_TRANSITION' } });
  await R.sqlTenant({
    id: 'CT-224', req: ['M5-A0196-8a7471', 'M5-A0263-1349d7', 'M5-A0051-1355bb', 'M5-A0052-d0edf7', 'M5-A0053-93822f', 'M5-A0054-f96f34', 'M5-A0055-965151', 'M5-A0056-103e8b', 'M5-A0057-c754d9', 'M5-A0058-6ae767', 'M5-A0059-0f891e', 'M5-A0060-eea580'], quem: 'A:leitura',
    descricao: 'Trilha auditada do ciclo completo: cada mudança de estado com antes/depois, na ordem do Guia §3',
    sql: "SELECT before_json->>'status' AS de, after_json->>'status' AS para FROM audit.audit_log WHERE entity_id = :id AND action IN ('legal.contract.status_change','legal.contract.suspend','legal.contract.reactivate','legal.contract.terminate','legal.contract.close') ORDER BY occurred_at",
    replacements: (c) => ({ id: c.ctCic }),
    avaliar: (r) => r.map((x) => `${x.de}>${x.para}`).join(',') === 'DRAFT>DOCUMENTS_PENDING,DOCUMENTS_PENDING>LEGAL_REVIEW,LEGAL_REVIEW>DRAFT,DRAFT>LEGAL_REVIEW,LEGAL_REVIEW>APPROVED,APPROVED>SIGNING,SIGNING>SIGNED,SIGNED>ACTIVE,ACTIVE>SUSPENDED,SUSPENDED>ACTIVE,ACTIVE>TERMINATED,TERMINATED>CLOSED',
  });
};
