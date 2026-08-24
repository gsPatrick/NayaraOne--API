'use strict';

const { RuleEvaluationLog } = require('../../models');
const { resolveApplicableVersion } = require('./ruleResolver');
const { evaluateNode, RuleEvaluationError } = require('./ruleEvaluator');

/**
 * Motor de Regras — orquestração (03_MOTORES_TRANSVERSAIS.md §1).
 *
 * `evaluateRule(ruleCode, context, tenant, options)` — `options.transaction` é OPCIONAL mas
 * deve ser passado sempre que o chamador já está dentro de uma transação de tenant (ver
 * ruleResolver.js) para que a RLS de "core"."rules"/"rule_versions"/"rule_scopes" enxergue o
 * `SET LOCAL app.group_id/app.company_id` já configurado nessa transação.
 *
 * `evaluateRule(ruleCode, context, tenant, options)` delega a resolução da versão vigente e
 * mais específica de uma regra para o escopo informado a ruleResolver.js (objeto > usuário >
 * unidade > departamento > empresa > grupo > global — RuleScope.precedence, menor número = mais
 * específico), avalia a condição resolvida contra `context` via ruleEvaluator.js, e registra a
 * decisão em "core"."rule_evaluation_log".
 *
 * FAIL CLOSED (RULE-001/03_MOTORES_TRANSVERSAIS.md §1.7): qualquer situação abaixo resulta em
 * `{ decision: 'DENY', reason: <code> }` — nunca em "aplicar como se estivesse liberado":
 *   - nenhuma regra/versão publicada e vigente encontrada para o código informado;
 *   - duas ou mais versões com a MESMA precedência mais específica aplicável ao contexto
 *     (RULE_CONFLICT — o motor não escolhe arbitrariamente);
 *   - erro de avaliação da condição (operador inválido, fact malformado, AST corrompido).
 *
 * Toda avaliação é registrada em "core"."rule_evaluation_log" para observabilidade
 * (03_MOTORES_TRANSVERSAIS.md §1.2 "Observabilidade das avaliações de regra").
 */
async function evaluateRule(ruleCode, context, tenant, options = {}) {
  const { groupId, companyId } = tenant || {};
  const now = options.now || new Date();
  const { transaction } = options;
  let outcome;

  try {
    const resolution = await resolveApplicableVersion(ruleCode, context, tenant, now, transaction);

    if (!resolution.ok) {
      outcome = { decision: 'DENY', reason: resolution.reason };
    } else {
      const chosenVersion = resolution.version;
      try {
        const matched = evaluateNode(chosenVersion.conditionAstJson, context);
        outcome = matched
          ? { decision: 'APPLY', reason: 'RULE_MATCHED', action: chosenVersion.actionJson, ruleVersionId: chosenVersion.id }
          : { decision: 'DENY', reason: 'RULE_CONDITION_NOT_MET', ruleVersionId: chosenVersion.id };
      } catch (evalErr) {
        if (evalErr instanceof RuleEvaluationError) {
          outcome = { decision: 'DENY', reason: 'RULE_EVALUATION_ERROR', detail: evalErr.message };
        } else {
          throw evalErr;
        }
      }
    }
  } catch (err) {
    // Qualquer erro inesperado (banco indisponível, etc.) também fecha a porta — nunca propaga
    // como "sem regra = liberado".
    outcome = { decision: 'DENY', reason: 'RULE_ENGINE_ERROR', detail: err.message };
  }

  try {
    // rule_evaluation_log.rule_version_id é NOT NULL — só registramos quando a resolução
    // chegou a identificar uma versão concreta (RULE_CONFLICT/CONTEXT_MISSING/NOT_FOUND
    // ficam apenas no log de aplicação/console, pois não há "versão avaliada" para associar).
    if (groupId && companyId && outcome.ruleVersionId) {
      await RuleEvaluationLog.create(
        {
          groupId,
          companyId,
          ruleVersionId: outcome.ruleVersionId,
          inputFactsJson: { context: context || {}, reason: outcome.reason },
          decision: outcome.decision,
          evaluatedAt: now,
        },
        { transaction }
      );
    }
  } catch (logErr) {
    // Falha ao gravar log de observabilidade nunca deve mascarar o resultado da avaliação
    // nem derrubar o fluxo de negócio — apenas registra em stderr.
    // eslint-disable-next-line no-console
    console.error('[RulesEngine] Falha ao gravar rule_evaluation_log:', logErr.message);
  }

  return outcome;
}

module.exports = { evaluateRule };
