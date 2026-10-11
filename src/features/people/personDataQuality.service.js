'use strict';

// Caderno (Marco 3, seção 16, "NAY Comercial"): "Classifica qualidade do cadastro e documentos
// faltantes." Dos 8 comportamentos da seção, este é o único puramente determinístico (uma regra
// de completude de campos, não geração de texto por IA) — não depende de nenhum provedor de
// LLM, que o projeto não tem integrado em nenhum módulo (confirmado por grep em toda a árvore
// `src/`: zero menção a OpenAI/Anthropic/chave de API de IA). Os demais 7 comportamentos da
// seção 16 (resumir histórico, gerar descrição de imóvel, sugerir recuperação etc.) exigem um
// LLM de verdade e continuam fora de escopo até existir essa integração.
//
// Pontuação simples e auditável: cada campo/checagem vale peso igual, sem “mágica” de IA —
// propositalmente, já que a nota alimenta decisão de negócio (ex: priorizar cadastro incompleto
// antes de publicar oferta) e precisa ser explicável.

const CHECKS = [
  { key: 'taxId', weight: 1, label: 'CPF/CNPJ informado', test: (p) => Boolean(p.taxIdNormalized) },
  { key: 'legalName', weight: 1, label: 'Nome/razão social informado', test: (p) => Boolean(p.legalName && p.legalName.trim()) },
  {
    key: 'contact',
    weight: 1,
    label: 'Ao menos um contato (telefone/e-mail) cadastrado',
    test: (p) => Array.isArray(p.contacts) && p.contacts.length > 0,
  },
  {
    key: 'address',
    weight: 1,
    label: 'Ao menos um endereço cadastrado',
    test: (p) => Array.isArray(p.addresses) && p.addresses.length > 0,
  },
  {
    key: 'document',
    weight: 1,
    label: 'Ao menos um documento anexado',
    test: (p) => Array.isArray(p.documents) && p.documents.length > 0,
  },
  {
    key: 'role',
    weight: 1,
    label: 'Ao menos um papel (cliente/proprietário/etc.) atribuído',
    test: (p) => Array.isArray(p.roles) && p.roles.length > 0,
  },
];

/**
 * Pontuação determinística de completude do cadastro (0 a 100) + lista do que falta.
 * `person` deve vir com `contacts`/`addresses`/`documents`/`roles` carregados (mesmo shape de
 * PERSON_INCLUDE em person.service.js); campos ausentes são tratados como "não preenchido".
 */
function scorePersonDataQuality(person) {
  const totalWeight = CHECKS.reduce((acc, c) => acc + c.weight, 0);
  let earned = 0;
  const missing = [];
  for (const check of CHECKS) {
    if (check.test(person)) {
      earned += check.weight;
    } else {
      missing.push({ key: check.key, label: check.label });
    }
  }
  return {
    score: Math.round((earned / totalWeight) * 100),
    missing,
  };
}

module.exports = { scorePersonDataQuality };
