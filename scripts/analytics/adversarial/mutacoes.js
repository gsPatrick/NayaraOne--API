'use strict';

/**
 * M9-D704 (critério "cada teste falha ao remover a proteção") — catálogo de mutações: para cada um dos 15 testes adversariais, o trecho do
 * código que é a PROTEÇÃO e o que o substitui para desligá-la. A mutação roda numa cópia da árvore (mutar.js), nunca no código real, e o teste
 * adversarial correspondente precisa FALHAR. `de` aparece exatamente uma vez em `arquivo` (um teste confere). Se o código da proteção mudar,
 * a mutação se atualiza junto: o teste m9d704 acusa o trecho que sumiu.
 */
const F = 'src/features/analytics';

const MUTACOES = [
  { adv: 1, arquivo: `${F}/metrics/formulas/finFreeCash.js`, protecao: 'o caixa livre subtrai o dinheiro de terceiros retido (caução)',
    de: 'const value = minus(totalCash, retained);', para: "const value = minus(totalCash, '0.00');" },
  { adv: 2, arquivo: `${F}/security/scope.js`, protecao: 'empresa inexistente ou de outro grupo é invisível: 404 sem revelar existência',
    de: 'if (!rows[0]) throw notFound();', para: 'if (!rows[0]) return requestedCompanyId;' },
  { adv: 3, arquivo: `${F}/metrics/freshness.signal.js`, protecao: 'métrica crítica com dado STALE ou EXPIRED é sinalizada ao alert engine',
    de: 'const isStale = (item) => item.state === STATES.STALE || item.state === STATES.EXPIRED;', para: 'const isStale = () => false;' },
  { adv: 4, arquivo: `${F}/metrics/registry.update.js`, protecao: 'alterar fórmula ou criticidade exige publicar uma nova versão',
    de: "throw AppError.conflict('Alterar a fórmula ou a criticidade exige publicar uma nova versão.', 'ANALYTICS_METRIC_REQUIRES_NEW_VERSION', { campos: changed });", para: 'void changed;' },
  { adv: 5, arquivo: `${F}/read-models/readModel.worker.js`, protecao: 'o evento já aplicado é ignorado (rm_applied_events com PK)',
    de: 'if (!claimed.length) {', para: 'if (false) {' },
  { adv: 6, arquivo: `${F}/alerts/engine.state.js`, protecao: 'condição repetida dentro do cooldown é suprimida, sem nova instância',
    de: 'resolved.cooldown_until && new Date(resolved.cooldown_until) > new Date(input.now)', para: 'false' },
  { adv: 7, arquivo: `${F}/metrics/sourceRefs.detail.js`, protecao: 'detalhe de linha exige a permissão do domínio',
    de: 'if (!(await detailAllowed(ctx, context.domain, transaction))) throw drilldownForbidden();', para: 'void detailAllowed;' },
  { adv: 8, arquivo: `${F}/exports/export.request.js`, protecao: 'exportação HIGH exige MFA recente (step-up)',
    de: "riskLevel === 'HIGH' ? await requireStepUp(ctx.actorUserId, transaction) : null", para: 'null' },
  { adv: 9, arquivo: `${F}/briefs/groundingValidator.js`, protecao: 'afirmação de causa sem registro de causa é bloqueada',
    de: 'const grounded = claimsCause &&', para: 'const grounded = true ||' },
  { adv: 10, arquivo: `${F}/quality/status.priority.js`, protecao: 'KPI DEGRADED nunca devolve valor (nulo, não zero)',
    de: "const isUnreliable = (status) => status === 'DEGRADED' || status === 'INCOMPLETE';", para: "const isUnreliable = (status) => status === 'INCOMPLETE';" },
  { adv: 11, arquivo: `${F}/metrics/consolidation/compute.js`, protecao: 'o consolidado subtrai as eliminações do intercompany na leitura',
    de: 'const total = money.sub(money.sum(companies.map((c) => c.value)), elimination);', para: 'const total = money.sum(companies.map((c) => c.value));' },
  { adv: 12, arquivo: 'scripts/analytics/load/verdict.js', protecao: 'o limite de degradação do OLTP (percentual ou piso) reprova o BI que degrada o fluxo operacional',
    de: 'return { pass: withinPct || withinFloor, byFloor: !withinPct && withinFloor };', para: 'return { pass: false, byFloor: false };' },
  { adv: 13, arquivo: `${F}/read-models/rebuild.swap.js`, protecao: 'o rebuild troca a tabela atual pelo conteúdo reconstruído da fonte (sombra)',
    de: 'SELECT ${columns} FROM ${T(shadowName(def.name))} WHERE company_id = :companyId', para: 'SELECT ${columns} FROM ${T(shadowName(def.name))} WHERE company_id = :companyId AND false' },
  { adv: 14, arquivo: `${F}/metrics/period.js`, protecao: 'o dia do período começa à 00:00 de São Paulo, não de UTC',
    de: 'return startOfBusinessDay(new Date(Date.UTC(y, m - 1, d, 12)), extraDays);', para: 'return new Date(Date.UTC(y, m - 1, d + extraDays));' },
  { adv: 15, arquivo: `${F}/metrics/formulas/money.js`, protecao: 'arredondamento meio para cima, único para todo o BI',
    de: 'if ((abs % unit) * 2n >= unit) q += 1n;', para: 'if ((abs % unit) * 2n > unit) q += 1n;' },
];

module.exports = { MUTACOES };
