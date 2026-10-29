'use strict';

// M9-D034 — capacidade 1: resumir a oportunidade. Estrutura { cliente, etapa, valorEstimado, ultimaInteracaoEm, diasSemContato,
// pendencias[] } e texto curto, com fonte (`crm.opportunities`, `crm.interactions`) e carimbo de tempo; nada vem do modelo.
const { dateBR, brl, plural } = require('./comercial.format');

const CHANNEL = Object.freeze({ WHATSAPP: 'WhatsApp', EMAIL: 'e-mail', SMS: 'SMS', PHONE: 'telefone', IN_PERSON: 'presencial', PORTAL: 'portal', INSTAGRAM: 'Instagram', OTHER: 'outro canal' });

/** Pendências: tarefas abertas, propostas enviadas sem resposta e documentos pendentes (o que o corretor precisa olhar). */
function pendenciasOf(facts, params) {
  const out = [];
  for (const t of facts.openTasks) out.push(`tarefa aberta "${t.title}"${t.dueAt ? ` (prazo ${dateBR(t.dueAt)})` : ''}`);
  for (const p of facts.proposals.filter((x) => x.unanswered)) out.push(`proposta enviada em ${dateBR(p.sentAt)} sem resposta há ${p.daysSinceSent} ${plural(p.daysSinceSent, 'dia', 'dias')}`);
  if (facts.pendingDocuments.length) out.push(`documentos pendentes: ${facts.pendingDocuments.join(', ')}`);
  if (!facts.closed && facts.daysWithoutContact > params.daysWithoutContact) out.push(`sem contato há ${facts.daysWithoutContact} dias (alerta a partir de ${params.daysWithoutContact})`);
  return out;
}

function structuredOf(facts, params) {
  return {
    cliente: facts.customerName,
    etapa: facts.stage,
    valorEstimado: facts.expectedValue,
    ultimaInteracaoEm: facts.lastInteractionAt,
    diasSemContato: facts.daysWithoutContact,
    pendencias: pendenciasOf(facts, params),
  };
}

function summaryResult(facts, params) {
  const s = structuredOf(facts, params);
  const contato = facts.lastInteractionAt
    ? `última interação em ${dateBR(facts.lastInteractionAt)}${s.diasSemContato === null ? '' : ` (${s.diasSemContato} ${plural(s.diasSemContato, 'dia', 'dias')} sem contato)`}`
    : `nenhuma interação registrada${s.diasSemContato === null ? '' : ` (${s.diasSemContato} ${plural(s.diasSemContato, 'dia', 'dias')} desde a abertura da oportunidade)`}`;
  const linhas = [
    `Resumo da oportunidade de ${s.cliente || 'cliente não identificado'} [1]: etapa ${s.etapa}${s.valorEstimado ? `; valor estimado ${brl(s.valorEstimado)}` : '; sem valor estimado'}; ${contato} [2].`,
    s.pendencias.length ? `Pendências: ${s.pendencias.join('; ')}.` : 'Sem pendências registradas.',
  ];
  const recentes = facts.interactions.slice(0, params.summaryInteractions)
    .map((i) => `${dateBR(i.occurredAt)} ${i.type === 'VISIT' ? 'visita' : `mensagem ${i.direction === 'INBOUND' ? 'recebida' : 'enviada'}${i.channel ? ` por ${CHANNEL[i.channel] || i.channel}` : ''}`}`);
  const texto = [
    `Oportunidade ${facts.opportunityId}. Cliente: ${s.cliente || '—'}. Etapa: ${s.etapa}.${s.valorEstimado ? ` Valor estimado: ${brl(s.valorEstimado)}.` : ''}`,
    `Última atividade: ${facts.lastInteractionAt ? dateBR(facts.lastInteractionAt) : 'nenhuma'}.`,
  ];
  return {
    answer: linhas.join('\n'),
    structured: s,
    snapshotAt: facts.asOf,
    sources: [
      { sourceType: 'READ_MODEL', sourceRef: `crm.opportunities:${facts.opportunityId}`, title: 'crm.opportunities', text: texto.join(' '), retrievedAt: facts.asOf },
      {
        sourceType: 'READ_MODEL', sourceRef: `crm.interactions:${facts.opportunityId}`, title: 'crm.interactions', retrievedAt: facts.asOf,
        text: `${recentes.length ? `Interações recentes: ${recentes.join('; ')}. ` : 'Nenhuma interação registrada. '}${s.diasSemContato === null ? '' : `Dias sem contato: ${s.diasSemContato}.`} ${s.pendencias.join('. ')}`.trim(),
      },
    ],
  };
}

module.exports = { summaryResult, structuredOf, pendenciasOf };
