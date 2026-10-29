# Runbook da integração ai-sandbox

Família: Modelos de IA (AI). Sandbox de modelos de IA: modelo de laboratório que obedece a marcadores de teste; nunca é usado em produção.

## 1. O que é e criticidade

Sandbox de modelos de IA: modelo de laboratório que obedece a marcadores de teste; nunca é usado em produção. Gera texto, vetores de busca, transcrições e análise de imagens para a NAY, dentro do orçamento e da política de dados de cada agente. Criticidade padrão da família: MEDIUM (o administrador pode alterar em Configurações, parâmetro integration.catalog.criticality.AI); a criticidade define a meta de sucesso (SLO), o prazo para considerar a sincronização parada e a severidade dos alertas. Efeito de uma queda: A NAY responde sem texto gerado (só com o que as regras calculam) ou recusa o pedido; o orçamento de IA pode ser consumido em tentativas.

## 2. Sintomas e alertas

- Alerta PROVIDER_DOWN, CIRCUIT_OPEN, QUOTA_LOW ou AUTH_FAILURE do fornecedor de modelo.
- Respostas da NAY com falha de fornecedor indisponível (503).
- Custo por execução acima do normal ou limite de tokens estourando.
- Como é um simulador local, falhas aqui indicam defeito do sistema ou do cenário de teste, não do fornecedor: conferir o ambiente do laboratório antes de acionar qualquer pessoa externa.

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Abrir Integrações > Saúde e localizar a linha do fornecedor ai-sandbox: conferir o estado de saúde (HEALTHY, DEGRADED, DOWN ou UNKNOWN), o estado do circuito (CLOSED, OPEN ou HALF_OPEN) e a taxa de sucesso da última hora.
2. Consultar GET /v1/admin/integrations/ai-sandbox/health para ver o último teste de saúde ativo (momento, resultado e latência), a série de métricas e a cota restante.
3. Abrir a fila de erros de integração (GET /v1/admin/integrations/errors) filtrada pelo fornecedor e ler a classe do erro mais recente: TRANSIENT e UNKNOWN indicam problema do fornecedor ou da rede; AUTH indica credencial; VALIDATION indica dado nosso; RATE_LIMIT indica cota.
4. Se o circuito estiver OPEN, anotar quando abriu e o tempo de espera (cooldown): as chamadas não essenciais esperam esse tempo sem gastar tentativa e só as essenciais seguem.
5. Conferir a fila de envios do fornecedor (pendentes, em nova tentativa, fila morta) e se há envios em UNKNOWN, que precisam de consulta antes de repetir.
6. Conferir os logs do laboratório e o cenário de teste em uso; o simulador não tem página de status.
7. Se a causa for credencial (AUTH), seguir a seção 5; se for cota, aguardar a renovação informada no painel; se for dado nosso (VALIDATION), corrigir o cadastro de origem e reenviar pela fila de erros.

## 4. Contingência

Modo de contingência da família: DEGRADE_TO_DETERMINISTIC. A NAY degrada para o caminho determinístico (regras e cálculos do servidor, sem texto gerado) e o fallback seguro de modelo só troca por um modelo equivalente e avaliado; nunca sobe para um modelo menos seguro. Referência: M9-D013 e M9-D228. A contingência é acionada quando o circuito abre, a integração perde a credencial, o teste de saúde marca DOWN ou não há conexão ativa, e é encerrada depois de verificações de saúde seguidas com sucesso, drenando a fila em ordem.

## 5. Como rotacionar credencial

O sandbox não usa credencial de fornecedor externo: não há segredo real a rotacionar. Se o ambiente de laboratório exigir uma referência de segredo, trocar a referência da integração em Integrações e validar o teste de conexão. Para uma integração real da mesma família, o procedimento é: Gerar a nova chave de API no console do fornecedor de modelo, gravar a nova versão no cofre pela rotação da integração (com MFA) e validar com uma execução de teste do laboratório de IA. Nunca colar o segredo em chat, ticket ou arquivo: ele só trafega pelo cofre. O vencimento da credencial é avisado com 30, 14 e 7 dias de antecedência (alerta SECRET_EXPIRING); credencial vencida coloca a integração em AUTH_FAILED e pausa os envios sem gastar tentativa até a reativação.

## 6. Quem acionar

Responsável pela NAY (administrador de IA) e administrador de integrações (contas e orçamento). As pessoas são as que ocupam essas funções na empresa no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar ao administrador de integrações e à diretoria.

## 7. Como validar a recuperação

O teste de saúde volta a ok, o circuito fecha, uma execução de teste do laboratório responde com fontes e o custo registrado, e a avaliação golden do agente continua verde. Registrar o horário de normalização e, se houve perda de dado ou atraso, abrir o registro correspondente no módulo de negócio afetado. O alerta se resolve sozinho quando a condição some e avisa a recuperação.
