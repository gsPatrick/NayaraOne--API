# NAY Correspondente (M9-D039)

Agente da NAY para o Correspondente Bancário: confere pendências de documentos e requisitos, compara simulações já registradas e informa o status do financiamento. **Somente leitura e sem decisão de crédito** (livro, seção 3).

## Arquivos

- `definition.js`: o cadastro do agente (finalidade, política, allowlist de 5 ferramentas, 4 escopos de dados, `max_tool_calls_por_run=5`). Gravado por `../kit` (`provisionAgentVersion` cria a versão da empresa em DRAFT e desabilitada; `applySystemDefinition` aplica ao padrão do sistema pelo `scripts/ai/seedSystemAgents.js`).
- `boundary.js`: fronteira do agente. Pedido fora do propósito ou com uma das cinco proibições (decidir/prever crédito, prometer taxa/prazo/parcela, enviar documento ao banco, chamar o provider, alterar status) é recusado com resposta 200, sem modelo (`../scope`). A resposta do modelo que promete o vedado é trocada (`checkAnswer`).
- `rules.js` + `rules.format.js`: resolvedores de regra (caminho RULE do roteador, sem modelo): `correspondente_casos_parados`, `correspondente_pendencias`, `correspondente_comparar_simulacoes`, `correspondente_status_caso`. Conferem `correspondent:read`; caso de outra empresa responde 404 `AI_CROSS_COMPANY_BLOCKED`.
- `readers.js`: as leituras (status, casos parados, exigências abertas, simulações comparadas), as mesmas das ferramentas `correspondent.*`. Reaproveitam `correspondent/correspondentNay.service.js`, que continua determinístico e inalterado.
- `golden.js`: dataset do agente (casos sintéticos) para `installGoldenCases`; a ativação exige a avaliação golden + adversarial verde e homologada por uma pessoa (agente de alto impacto).
- `correspondente.settings.js`: parâmetros `ia.correspondente.*` (aba IA NAY): listas de termos da fronteira e os dois limites de itens. O limiar de caso parado é o `stalledCaseDays` do Correspondente (padrão 7).

## Garantias

Nenhuma ferramenta de escrita na allowlist; nenhuma recomendação nem proposta nasce do agente (`readOnly` no gancho: o aviso de confirmação humana fica no texto, sem criar `ai.ai_recommendations`); valores de simulação só de simulações registradas, nunca estimativa nova.

## Como testar

`test/marco9/ia/m9d039.*.test.js` (banco descartável, ver `scripts/withDisposableDb.js`).
