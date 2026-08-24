# Motor de Regras (`src/engines/rules/`)

Implementação inicial (Marco 2) do Motor de Regras descrito em
`Maturacao/03_MOTORES_TRANSVERSAIS.md §1`. Não é uma feature HTTP — é um módulo de biblioteca
consumido por services de outros domínios (financeiro, comissões, etc., a partir do Marco 3+).

## `evaluateRule(ruleCode, context, { groupId, companyId }, options)`

```js
const { evaluateRule } = require('../../engines/rules/rulesEngine');

const result = await evaluateRule(
  'REG-FIN-001',
  { amount: 5000, unitId, userId },
  { groupId, companyId }
);
// result.decision === 'APPLY' | 'DENY'
```

Resolve a versão **publicada e vigente** (`status='PUBLISHED'`, `effective_from <= now <=
effective_until`) de `core.rules`/`core.rule_versions` com o escopo (`core.rule_scopes`) mais
específico aplicável ao `context`, seguindo a precedência de
`03_MOTORES_TRANSVERSAIS.md §1.3` (objeto > usuário > unidade > departamento > empresa >
grupo > global — `rule_scopes.precedence`, menor valor = mais específico).

## Fail-closed (RULE-001 / §1.7)
Qualquer situação abaixo retorna `{ decision: 'DENY', reason: <code> }` — nunca "aplica por
omissão":

| `reason` | Situação |
|---|---|
| `RULE_CONTEXT_MISSING` | `ruleCode`/`groupId`/`companyId` ausentes |
| `RULE_NOT_FOUND` | Nenhuma `core.rules` com esse `code` no tenant |
| `RULE_NO_ACTIVE_VERSION` | Sem versão `PUBLISHED` vigente na data |
| `RULE_NO_MATCHING_SCOPE` | Nenhum `rule_scopes` aplicável ao `context` |
| `RULE_CONFLICT` | Duas ou mais versões empatam na precedência mais específica — o motor **não escolhe arbitrariamente** |
| `RULE_CONDITION_NOT_MET` | Versão resolvida, mas a condição não bateu contra o `context` |
| `RULE_EVALUATION_ERROR` | AST malformado/operador inválido |
| `RULE_ENGINE_ERROR` | Erro inesperado (ex. banco indisponível) |

Toda avaliação que chega a identificar uma `rule_version_id` concreta é registrada em
`core.rule_evaluation_log` (observabilidade — `input_facts_json` guarda `context` + `reason`).
Denials anteriores a essa etapa (contexto ausente, regra não encontrada, conflito) **não são
persistidos** nessa tabela porque `rule_version_id` é `NOT NULL` no schema atual — ficam
apenas no retorno da função e em log de aplicação (`console.error` só em erro inesperado).
Isso é uma limitação conhecida do schema herdado, não uma omissão — ver "Pendências" abaixo.

## DSL segura (`src/engines/rules/ruleEvaluator.js`)
`condition_ast_json` é uma árvore JSON simples:
```json
{ "and": [
  { "fact": "amount", "op": ">", "value": 1000 },
  { "or": [ { "fact": "unitId", "op": "==", "value": "..." }, { "not": { "fact": "status", "op": "==", "value": "BLOCKED" } } ] }
]}
```
Operadores: `==, !=, >, >=, <, <=, IN, NOT_IN`. Sem JavaScript/SQL arbitrário, sem acesso a
filesystem/rede/relógio externo — apenas os literais do AST e o `context` explicitamente
passado pelo chamador. `fact` resolve um caminho `a.b.c` dentro do `context`.

## Decisão de design (para revisão)
A DSL implementada cobre o mínimo exigido (`AND/OR/NOT` + comparadores) sem funções puras
nomeadas (`days_between()`, `contains()` citadas no Caderno) — a interface (`evaluateNode`)
está isolada o bastante para acrescentar uma tabela de funções registradas sem quebrar o
formato do AST. Simulação (`rule_simulations`), aprovação segregada
(`rule_approval_requests/steps`) e teste obrigatório antes de publicar (`rule_test_cases`)
**não foram implementados nesta etapa** — as tabelas existem (migrations já aplicadas) mas
não há service/rota consumindo-as ainda; ficam para o Marco correspondente ao domínio que
primeiro precisar publicar regra via API (o motor de leitura/avaliação já está pronto para
consumir o que for publicado diretamente via SQL/seed até lá).
