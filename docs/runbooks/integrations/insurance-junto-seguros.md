# Runbook da integração insurance-junto-seguros

Família: Seguradoras e garantias (INSURANCE). Seguradora Junto Seguros: registrada no catálogo sem integração disponível (a documentação técnica só abre depois da parceria de corretora); toda operação é recusada com PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED.

## 1. O que é e criticidade

Seguradora Junto Seguros: registrada no catálogo sem integração disponível (a documentação técnica só abre depois da parceria de corretora); toda operação é recusada com PROCUREMENT_INSURANCE_PROVIDER_NOT_IMPLEMENTED. Cota, propõe e acompanha seguros e garantias locatícias e consulta apólices e status. Criticidade padrão da família: HIGH (o administrador pode alterar em Configurações, parâmetro integration.catalog.criticality.INSURANCE); a criticidade define a meta de sucesso (SLO), o prazo para considerar a sincronização parada e a severidade dos alertas. Efeito de uma queda: Cotações e propostas de seguro não andam; apólices podem vencer sem renovação.

## 2. Sintomas e alertas

- Alerta PROVIDER_DOWN ou CIRCUIT_OPEN da seguradora.
- Propostas em UNKNOWN ou sem retorno.
- Erros de validação da seguradora em lote.
- Como é um simulador local, falhas aqui indicam defeito do sistema ou do cenário de teste, não do fornecedor: conferir o ambiente do laboratório antes de acionar qualquer pessoa externa.

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Abrir Integrações > Saúde e localizar a linha do fornecedor insurance-junto-seguros: conferir o estado de saúde (HEALTHY, DEGRADED, DOWN ou UNKNOWN), o estado do circuito (CLOSED, OPEN ou HALF_OPEN) e a taxa de sucesso da última hora.
2. Consultar GET /v1/admin/integrations/insurance-junto-seguros/health para ver o último teste de saúde ativo (momento, resultado e latência), a série de métricas e a cota restante.
3. Abrir a fila de erros de integração (GET /v1/admin/integrations/errors) filtrada pelo fornecedor e ler a classe do erro mais recente: TRANSIENT e UNKNOWN indicam problema do fornecedor ou da rede; AUTH indica credencial; VALIDATION indica dado nosso; RATE_LIMIT indica cota.
4. Se o circuito estiver OPEN, anotar quando abriu e o tempo de espera (cooldown): as chamadas não essenciais esperam esse tempo sem gastar tentativa e só as essenciais seguem.
5. Conferir a fila de envios do fornecedor (pendentes, em nova tentativa, fila morta) e se há envios em UNKNOWN, que precisam de consulta antes de repetir.
6. Conferir os logs do laboratório e o cenário de teste em uso; o simulador não tem página de status.
7. Se a causa for credencial (AUTH), seguir a seção 5; se for cota, aguardar a renovação informada no painel; se for dado nosso (VALIDATION), corrigir o cadastro de origem e reenviar pela fila de erros.

## 4. Contingência

A família Seguradoras e garantias não tem modo de contingência próprio no livro: valem a fila e a nova tentativa por classe de erro do Dispatch Service. Os envios ficam em PENDING e RETRY_WAIT sem perder nada, o circuito aberto adia o que não é essencial sem gastar tentativa e a fila morta guarda o que esgotou as tentativas para reenvio manual pela tela de erros. Se o administrador elevar a criticidade da família a CRITICAL, passa a valer a política de contingência da M9-D226. Referência: M9-D214, M9-D216 e M9-D226.

## 5. Como rotacionar credencial

A Junto Seguros não tem credencial no sistema: não há segredo a rotacionar. Quando a parceria de corretora for formalizada e a documentação técnica estiver disponível, a integração real entra como adapter novo, com a credencial gravada no cofre pela rotação da integração (com MFA). Nunca colar o segredo em chat, ticket ou arquivo.

## 6. Quem acionar

Responsável por seguros e contratos da empresa e administrador de integrações. As pessoas são as que ocupam essas funções na empresa no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar ao administrador de integrações e à diretoria.

## 7. Como validar a recuperação

Enquanto não houver integração, a seleção "junto_seguros" em Configurações recusa cotação, emissão e sinistro com a mensagem de provedor sem integração disponível. Para seguir, selecionar o sandbox (homologação), o fluxo manual ou uma seguradora com credencial configurada, e conferir que nenhuma apólice foi criada sem passar por uma seguradora real ou pelo fluxo manual.
