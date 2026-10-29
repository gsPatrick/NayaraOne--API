# evaluations
AiEvaluationService: avaliações e homologação.

## golden (M9-D033)

`golden/` guarda o golden dataset por agente em `ai.golden_cases` (versionado; corrigir cria a versão seguinte; a linha é imutável por gatilho). Entra na avaliação pela porta `registerCaseSource` (`goldenSource.js`), com dados sempre sintéticos (recusa dado pessoal e segredo). `goldenCoverage.js` exige ao menos um caso por categoria aplicável (409 `AI_GOLDEN_INSUFFICIENT`). Um candidato aprovado por pessoa (D032) só vira caso por `promoteCandidate`. Os perfis `sandbox-a` e `sandbox-b` (`../providers/sandbox/sandboxProfiles.js`) provam em CI que trocar de provedor mantém o golden verde.

## adversarial (M9-D042)

`adversarial/` registra, pela porta `registerCaseSource`, os 15 casos da suíte ADVERSARIAL do livro (categorias INJECTION e PERMISSIONS, 100% obrigatório), no lugar dos casos de base de injeção. Cada caso roda uma sonda de produção sem escrita no banco; o cenário completo de cada um (orquestrador, banco, eventos) é o teste de mesmo nome em `test/marco9/ia/adversarial/`, que o manifesto `adversarial.manifest.json` vigia e `npm run test:ai:adversarial` resume em `adversarial-report.json`.
