'use strict';

// Apoio dos testes de privacidade da NAY (M9-D027): provider sandbox em modo espelho, tipo de tarefa, guarda de campos (aiAccess)
// de mentira e fábrica de fonte. O sandbox não chama rede: guarda o que recebeu e responde de forma previsível.
const { redactForAi } = require('../../../src/shared/redaction');

/** Provider sandbox determinístico (M9-D011 faz o oficial): `mirror` guarda cada payload recebido; a resposta repete os placeholders. */
function createSandboxProvider(descriptor = {}) {
  const mirror = [];
  return {
    descriptor: { code: 'sandbox', external: true, allowsConfidential: false, allowsRestricted: false, dataRetention: 'THIRTY_DAYS', contractRef: null, ...descriptor },
    mirror,
    async complete(messages) {
      mirror.push(JSON.stringify(messages));
      const dados = JSON.parse(messages[messages.length - 1].content);
      const nome = dados.cliente && dados.cliente.nome;
      return `Resposta para ${nome || 'a pessoa'}: cpf ${dados.cliente && dados.cliente.cpf}.`;
    },
  };
}

/** Guarda de campos que libera tudo, exceto as referências proibidas. Registra cada chamada. */
function createAiAccess({ blocked = [] } = {}) {
  const calls = [];
  return {
    calls,
    async assertAllowed(fields, agentContext) {
      calls.push({ fields, agentContext });
      return {
        allowedFields: fields.filter((f) => !blocked.includes(f.ref)).map((f) => f.ref),
        removedFields: fields.filter((f) => blocked.includes(f.ref)).map((f) => f.ref),
      };
    },
  };
}

const TAREFA = 'resumir_cobranca';
const CAMPOS_TAREFA = { fields: ['cliente.nome', 'cliente.cpf', 'parcela.valor', 'parcela.vencimento', 'documento.trecho'], nameFields: ['cliente.nome'] };

const fonte = (tenant, over = {}) => ({
  id: over.id || 'fonte-1', key: 'parcela', classification: 'INTERNAL', groupId: tenant.groupId, companyId: tenant.companyId,
  fields: { valor: '100.00', vencimento: '2026-11-10', segredoInterno: 'nao-deve-passar' }, ...over,
});

/** true se o texto já está sem dado pessoal/segredo (redigir de novo não muda nada). */
const semPii = (texto) => redactForAi(String(texto)) === String(texto);

module.exports = { createSandboxProvider, createAiAccess, TAREFA, CAMPOS_TAREFA, fonte, semPii };
