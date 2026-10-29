# evaluations
AiEvaluationService: avaliações e homologação.

## golden (M9-D033)

`golden/` guarda o golden dataset por agente em `ai.golden_cases` (versionado; corrigir cria a versão seguinte; a linha é imutável por gatilho). Entra na avaliação pela porta `registerCaseSource` (`goldenSource.js`), com dados sempre sintéticos (recusa dado pessoal e segredo). `goldenCoverage.js` exige ao menos um caso por categoria aplicável (409 `AI_GOLDEN_INSUFFICIENT`). Um candidato aprovado por pessoa (D032) só vira caso por `promoteCandidate`. Os perfis `sandbox-a` e `sandbox-b` (`../providers/sandbox/sandboxProfiles.js`) provam em CI que trocar de provedor mantém o golden verde.
