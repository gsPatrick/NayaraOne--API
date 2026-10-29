# nay_diretoria

NAY Diretoria (M9-D035): saúde da empresa, riscos, prioridades e explicações. Somente leitura e só agregados.

- `diretoria.policy.js`: cadastro do agente (finalidade, política, escopos `*.summary`, limite de 8 tools, allowlist exata de 8 tools de leitura, as três proibições). `DEFINITION` é o que `agents/kit` grava na empresa (`provisionAgentVersion`) e no padrão do sistema (`scripts/ai/seedSystemAgents.js`).
- `diretoria.settings.js`: parâmetros da aba IA NAY (faixas de vencimento, limites de severidade, tamanho das listas e as listas de termos da fronteira).
- `diretoria.resolvers.js`: tarefas de regra (`diretoria_saude`, `diretoria_riscos`, `diretoria_prioridades`, `diretoria_explicar_indicador`), sem modelo. Leem as áreas pelas mesmas definições de tool (`diretoria.data.js`); o texto vem de `diretoria.health.js`, `diretoria.riskText.js` e `diretoria.indicators.js`; a severidade é de `diretoria.risks.js`.
- `diretoria.numbers.js`: extratores do `numbersPayload` das tools de área (o servidor escreve cada número).
- `diretoria.decorate.js`: troca "Sem permissão para <tema>." por "<Área>: sem acesso." na conversa com ferramentas.
- `diretoria.golden.js`: golden dataset sintético.
- `index.js`: registra a fronteira (escopo e proibições por parâmetro), o gancho `readOnly` e os resolvedores.

A tool compartilhada (`legal.getExpiringContracts`, `correspondent.getStalledCases`) devolve agregado ou lista nominal conforme o escopo de dados do agente chamador (`toolServices/summaryScope.js`).
