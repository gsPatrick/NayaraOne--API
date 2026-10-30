# Runbook de operação da IA NAY

Família: IA NAY (Marco 9, bloco A). Este é o runbook de quem opera a NAY no dia a dia; o da integração com o provedor de modelo é `docs/runbooks/integrations/<provider>.md`. A NAY está em estado PRONTO PARA LAB: produção só depois das avaliações, do red-team, da segurança e da privacidade (portão `/v1/ai/release-gates`, M9-D046).

## 1. O que é e criticidade

A NAY é a assistente de IA do Nayara One: roda agentes (comercial, financeira, obras, jurídica, atendimento, diretoria, correspondente, documental) que respondem com fontes, propõem ações e nunca executam escrita sem aprovação humana. Criticidade: MÉDIA para a operação (a NAY ajuda, não é caminho único de nenhum processo); ALTA para segurança e privacidade, porque lê dados da empresa. Quando a NAY cai, o sistema continua funcionando e as respostas passam a vir só das regras e dos cálculos do servidor, ou a NAY recusa o pedido com o motivo.

## 2. Sintomas e alertas

- Métricas em `GET /api/metrics` (formato Prometheus): `ai_runs_total{agent,status,path}` (execuções), `ai_run_latency_ms` (histograma para p50, p95 e p99), `ai_cost_brl_total{agent,provider}` (custo em reais), `ai_tool_calls_total{tool,status}`, `ai_blocked_total{reason}` (execuções bloqueadas), `ai_insufficient_sources_total` (respostas "não há fonte suficiente"), `ai_injection_detected_total{origin}` (tentativas de injeção), `ai_fallback_total{from,to}` (troca de modelo), `ai_budget_pct{budget}` (percentual do orçamento) e `ai_provider_circuit_open{provider}` (1 = circuito aberto).
- Sinais de saúde ruim: `ai_runs_total` com status FAILED subindo, p95 acima do normal, `ai_fallback_total` crescendo, `ai_provider_circuit_open` em 1, `ai_budget_pct` perto de 100.
- Sinais de ataque ou abuso: `ai_injection_detected_total` e `ai_blocked_total` subindo de repente, sobretudo por uma única origem ou motivo.
- Sinais de gasto: `ai_cost_brl_total` acima do orçamento da empresa; os alertas de 50, 75, 90 e 100 por cento chegam como notificação a quem tem a permissão de orçamento de IA.
- Cada métrica só conta a empresa que mantém ligado o parâmetro `ia.observabilidade.metricas_ativas` (Configurações, aba IA NAY, padrão ligado).

## 3. Diagnóstico passo a passo

1. Pegar o `correlationId` do pedido (cabeçalho `X-Correlation-Id` da resposta) ou o `runId` (campo `runId` da resposta, ou `GET /v1/ai/runs/:id`). Todo log da NAY traz os dois campos, `correlationId` e `runId` (null quando não existem), então um filtro por qualquer um deles reconstrói a execução.
2. Abrir o run: estado (COMPLETED, FAILED, BLOCKED, AWAITING_APPROVAL), motivo do bloqueio, caminho (RULE, SMALL_MODEL, ADVANCED_MODEL, CACHE), provedor, modelo, custo e a trilha de fallback.
3. Se for BLOCKED, conferir o motivo (`ai_blocked_total{reason}`): permissão, escopo da ferramenta, injeção, segredo, orçamento ou classificação do dado. O motivo diz qual regra do livro barrou.
4. Se for FAILED por provedor, conferir `ai_provider_circuit_open` e a saúde da integração em Integrações, Saúde (runbook do provedor).
5. Se for custo, conferir `ai_budget_pct` e `GET /v1/ai/budgets`; um agente ou modelo específico pode estar consumindo tudo.
6. Para a saúde geral, rodar `npm run ai:dod` (Definition of Done) e `npm run ai:arch-guard`: eles dizem qual item do livro está sem prova.
7. Para reproduzir uma falha em ambiente de teste, usar os ensaios `scripts/ai-drill-*.js` em banco descartável, nunca no banco publicado.

## 4. Contingência

- Desligar a NAY de uma empresa: parâmetro `ia.habilitada` (Configurações, aba IA NAY); desligar um agente: `ai.agents.enabled`. Desligada a chave geral, a rota responde 503 `AI_FEATURE_DISABLED`; agente fora da lista, 409 `AI_AGENT_DISABLED`. Nenhum run abre.
- Provedor indisponível: o fallback seguro troca só para um modelo equivalente e avaliado (M9-D013); sem candidato elegível a NAY responde 503 `AI_PROVIDER_UNAVAILABLE` e não inventa resposta. Circuito aberto: aguardar o tempo de espera ou seguir o runbook do provedor.
- Orçamento no limite: a partir do limiar de degradação o roteador usa só regras, cache e modelo pequeno; ao chegar em 100 por cento, conforme a ação configurada, bloqueia (429) ou deixa só regras e cache. Aumentar o limite exige a permissão de orçamento de IA (`PUT /v1/ai/budgets/:id`).
- Suspeita de vazamento ou de injeção: desligar o agente envolvido, preservar o `runId` e o `correlationId`, abrir a trilha de auditoria do run e acionar o responsável por segurança. Nenhum texto bruto de documento ou de prompt fica no log por desenho.
- Ensaios de falha previstos no livro: `scripts/ai-drill-circuito-aberto.js`, `ai-drill-orcamento-estoura.js`, `ai-drill-provedor-cai.js`, `ai-drill-secret-revogado.js`, `ai-drill-outbox-parado.js`, `ai-drill-indice-rag.js` e `ai-drill-timeout-proposta.js`.

## 5. Como rotacionar credencial

A chave do provedor de modelo vive no cofre de segredos das integrações, nunca no código, no log ou em arquivo versionado. Rotacionar: gerar a nova chave no console do fornecedor, gravar a nova versão do segredo pela rotação da integração (exige MFA do administrador, feito pela pessoa), rodar o teste de conexão e uma execução de teste do laboratório de IA, e só então revogar a chave antiga. Chave vazada: revogar primeiro no fornecedor, depois rotacionar; o ensaio `scripts/ai-drill-secret-revogado.js` mostra o comportamento esperado (a NAY falha fechada e avisa). Nunca colar a chave em chat, ticket ou arquivo.

## 6. Quem acionar

O administrador de IA da empresa (quem tem a permissão de administração da NAY) é o primeiro contato; o administrador de integrações cuida de provedor, conta e orçamento; a diretoria decide liberação para produção. As pessoas são as que ocupam essas funções no momento: este runbook não guarda nomes nem telefones. Função vaga: escalar ao administrador de integrações e à diretoria.

## 7. Como validar a recuperação

Conferir que `ai_runs_total` volta a registrar COMPLETED, que o p95 de `ai_run_latency_ms` voltou ao normal, que `ai_provider_circuit_open` está em 0 e que `ai_fallback_total` parou de crescer. Rodar uma execução de teste do laboratório com um agente de leitura, confirmar fontes citadas e custo registrado, e rodar `npm run ai:dod`: todos os 16 itens com prova e as quatro perguntas da autochecagem respondidas. Registrar o horário da normalização.
