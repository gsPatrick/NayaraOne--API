# Runbook da integração analytics-sandbox

Família: Analytics e monitoramento (ANALYTICS). Sandbox de analytics: simulador determinístico do laboratório.

## 1. O que é e criticidade

Sandbox de analytics: simulador determinístico do laboratório. Recebe métricas e eventos técnicos da operação para monitoramento e consulta a saúde da própria plataforma de monitoramento. Criticidade padrão da família: LOW (o administrador pode alterar em Configurações, parâmetro integration.catalog.criticality.ANALYTICS); a criticidade define a meta de sucesso (SLO), o prazo para considerar a sincronização parada e a severidade dos alertas. Efeito de uma queda: Perde-se visibilidade técnica; nenhuma operação de negócio depende dele.

## 2. Sintomas e alertas

- Alerta PROVIDER_DOWN ou CIRCUIT_OPEN do monitoramento.
- Métricas e eventos sem chegar ao painel.
- Erros de credencial no envio de métricas.
- Como é um simulador local, falhas aqui indicam defeito do sistema ou do cenário de teste, não do fornecedor: conferir o ambiente do laboratório antes de acionar qualquer pessoa externa.

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Abrir Integrações > Saúde e localizar a linha do fornecedor analytics-sandbox: conferir o estado de saúde (HEALTHY, DEGRADED, DOWN ou UNKNOWN), o estado do circuito (CLOSED, OPEN ou HALF_OPEN) e a taxa de sucesso da última hora.
2. Consultar GET /v1/admin/integrations/analytics-sandbox/health para ver o último teste de saúde ativo (momento, resultado e latência), a série de métricas e a cota restante.
3. Abrir a fila de erros de integração (GET /v1/admin/integrations/errors) filtrada pelo fornecedor e ler a classe do erro mais recente: TRANSIENT e UNKNOWN indicam problema do fornecedor ou da rede; AUTH indica credencial; VALIDATION indica dado nosso; RATE_LIMIT indica cota.
4. Se o circuito estiver OPEN, anotar quando abriu e o tempo de espera (cooldown): as chamadas não essenciais esperam esse tempo sem gastar tentativa e só as essenciais seguem.
5. Conferir a fila de envios do fornecedor (pendentes, em nova tentativa, fila morta) e se há envios em UNKNOWN, que precisam de consulta antes de repetir.
6. Conferir os logs do laboratório e o cenário de teste em uso; o simulador não tem página de status.
7. Se a causa for credencial (AUTH), seguir a seção 5; se for cota, aguardar a renovação informada no painel; se for dado nosso (VALIDATION), corrigir o cadastro de origem e reenviar pela fila de erros.

## 4. Contingência

A família Analytics e monitoramento não tem modo de contingência próprio no livro: valem a fila e a nova tentativa por classe de erro do Dispatch Service. Os envios ficam em PENDING e RETRY_WAIT sem perder nada, o circuito aberto adia o que não é essencial sem gastar tentativa e a fila morta guarda o que esgotou as tentativas para reenvio manual pela tela de erros. Se o administrador elevar a criticidade da família a CRITICAL, passa a valer a política de contingência da M9-D226. Referência: M9-D214, M9-D216 e M9-D226.

## 5. Como rotacionar credencial

O sandbox não usa credencial de fornecedor externo: não há segredo real a rotacionar. Se o ambiente de laboratório exigir uma referência de segredo, trocar a referência da integração em Integrações e validar o teste de conexão. Para uma integração real da mesma família, o procedimento é: Gerar a nova chave no serviço de monitoramento, gravar a nova versão no cofre pela rotação da integração (com MFA) e validar enviando uma métrica de teste. Nunca colar o segredo em chat, ticket ou arquivo: ele só trafega pelo cofre. O vencimento da credencial é avisado com 30, 14 e 7 dias de antecedência (alerta SECRET_EXPIRING); credencial vencida coloca a integração em AUTH_FAILED e pausa os envios sem gastar tentativa até a reativação.

## 6. Quem acionar

Administrador de integrações e responsável técnico pela infraestrutura. As pessoas são as que ocupam essas funções na empresa no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar ao administrador de integrações e à diretoria.

## 7. Como validar a recuperação

O teste de saúde volta a ok, o circuito fecha, e uma métrica de teste enviada aparece no painel do monitoramento. Registrar o horário de normalização e, se houve perda de dado ou atraso, abrir o registro correspondente no módulo de negócio afetado. O alerta se resolve sozinho quando a condição some e avisa a recuperação.
