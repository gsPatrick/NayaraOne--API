'use strict';

// M9-D034 — resolvedores RULE da NAY Comercial (caminho sem modelo do ModelRouter, D012). O pedido escolhe a capacidade pelo
// `taskType`; a oportunidade vem do `context` (subject), de um UUID no texto ou do nome do cliente. Sem permissão: 403.
const { loadOpportunityFacts } = require('./comercial.data');
const { listRadarMatches } = require('./comercial.radar');
const { readComercialParams } = require('./comercial.params');
const { resolveOpportunity } = require('./comercial.resolve');
const { isMine, assertCan, nowOf } = require('./comercial.access');
const { summaryResult } = require('./comercial.summary');
const { nextActionResult } = require('./comercial.nextAction');
const { propertyDraft, recoveryDraft } = require('./comercial.drafts');
const { plural } = require('./comercial.format');
const { TASKS } = require('./comercial.policy');
const { scopeOfActor } = require('./comercial.scope');
const { draftByModel } = require('./comercial.capParams');

const CRM = 'crm:opportunities:read';

/** Várias oportunidades combinam com o nome: a resposta pergunta qual (nada é escolhido pelo servidor ou pelo modelo). */
function ambiguousAnswer(found, now) {
  const linhas = found.ambiguous.map((o, i) => `${i + 1}. ${o.customerName} — etapa ${o.stage} (id ${o.id})`);
  return { answer: `Encontrei mais de uma oportunidade com esse nome. Informe qual delas:\n${linhas.join('\n')}`, snapshotAt: now.toISOString(), sources: [] };
}

/**
 * Oportunidade do pedido, na carteira de quem pede (livro do Marco 3 §18: o corretor com `crm:opportunities:read:own` só alcança as dele;
 * a de outro corretor é o mesmo 404 da inexistente). `ownerScope` vai junto para toda leitura de fatos.
 */
async function withOpportunity(ruleInput, env, fn) {
  if (!isMine(ruleInput)) return null;
  const now = nowOf(ruleInput);
  const ownerScope = scopeOfActor(ruleInput);
  const found = await resolveOpportunity(ruleInput, env.transaction, ownerScope);
  if (!found) return null;
  if (found.ambiguous) return ambiguousAnswer(found, now);
  const params = await readComercialParams(env.tenant, env.transaction);
  return fn({ id: found.id, now, params, ownerScope });
}

const resumir = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, CRM);
  return withOpportunity(ruleInput, env, async ({ id, now, params, ownerScope }) => summaryResult(await loadOpportunityFacts(id, env.transaction, { now, ownerScope }), params));
};

const sugerir = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, CRM);
  return withOpportunity(ruleInput, env, async ({ id, now, params, ownerScope }) => nextActionResult(await loadOpportunityFacts(id, env.transaction, { now, ownerScope }), params));
};

const radar = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, CRM, 'radar:read');
  return withOpportunity(ruleInput, env, async ({ id, now, params, ownerScope }) => {
    const list = await listRadarMatches(id, env.transaction, { limit: params.radarMax, ownerScope });
    const asOf = now.toISOString();
    const head = list.total
      ? `Imóveis do Radar compatíveis com a oportunidade [1]: ${list.total} ${plural(list.total, 'imóvel', 'imóveis')}${list.hasMore ? `, mostrando os ${list.shown} de maior pontuação` : ''}.`
      : 'O Radar não tem imóveis compatíveis com esta oportunidade no momento [1].';
    const linhas = list.matches.map((m, i) => `${i + 1}. ${m.title || `Imóvel ${m.propertyId}`}${m.city ? ` (${m.city})` : ''} — pontuação ${m.score.toLocaleString('pt-BR')}. ${m.reason}`);
    const aviso = list.hasMore ? `Há mais ${list.extra} ${plural(list.extra, 'imóvel', 'imóveis')} além dos ${list.shown} listados.` : null;
    return {
      answer: [head, ...linhas, aviso].filter(Boolean).join('\n'),
      snapshotAt: asOf,
      structured: { total: list.total, exibidos: list.shown, haMais: list.extra, imoveis: list.matches },
      sources: [
        { sourceType: 'READ_MODEL', sourceRef: `radar.matches:${id}`, title: 'radar.matches', retrievedAt: asOf, text: `Radar da oportunidade ${id}. ${list.total} imóveis compatíveis; ${list.shown} listados.${list.matches.map((m) => ` ${m.title || m.propertyId}: ${m.reason}`).join('')}` },
        { sourceType: 'READ_MODEL', sourceRef: `properties:${id}`, title: 'properties', retrievedAt: asOf, text: list.matches.map((m) => `${m.title || m.propertyId}${m.city ? ` (${m.city})` : ''}`).join('; ') || 'Nenhum imóvel.' },
      ],
    };
  });
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const rascunharImovel = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, 'properties:read');
  const s = ruleInput.subject;
  const id = s && String(s.type).toLowerCase() === 'property' && UUID.test(String(s.id)) ? String(s.id) : (UUID.exec(String(ruleInput.input || '')) || [])[0];
  // Redação por modelo ligada (`ia.comercial.redacao_por_modelo`): o resolvedor sai e o modelo redige SÓ com os fatos públicos aprovados
  // que o servidor entrega (comercial.sources.js); a saída passa pela guarda da descrição (comercial.review.js).
  if (id && await draftByModel(env.tenant, env.transaction)) return null;
  return id ? propertyDraft(id, nowOf(ruleInput), env.transaction) : null;
};

const rascunharRecuperacao = async (ruleInput, env) => {
  if (!isMine(ruleInput)) return null;
  assertCan(ruleInput, CRM, 'people:read');
  return withOpportunity(ruleInput, env, async ({ id, now, ownerScope }) => recoveryDraft(await loadOpportunityFacts(id, env.transaction, { now, ownerScope })));
};

const RESOLVERS = Object.freeze({
  [TASKS.SUMMARY]: resumir, [TASKS.NEXT_ACTION]: sugerir, [TASKS.RADAR]: radar, [TASKS.PROPERTY_DRAFT]: rascunharImovel, [TASKS.RECOVERY_DRAFT]: rascunharRecuperacao,
});

module.exports = { RESOLVERS, withOpportunity };
