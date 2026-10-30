# Runbook da integração insurance-manual

Família: Seguradoras e garantias (INSURANCE). Fluxo manual de seguros: a seguradora sem API cumpre o mesmo port por tarefas a uma pessoa (anexar a cotação recebida, registrar o número da proposta e anexar a apólice), com o mesmo modelo de dados e os mesmos eventos.

## 1. O que é e criticidade

Fluxo manual de seguros: a seguradora sem API cumpre o mesmo port por tarefas a uma pessoa (anexar a cotação recebida, registrar o número da proposta e anexar a apólice), com o mesmo modelo de dados e os mesmos eventos. Cota, propõe e acompanha seguros e garantias locatícias e consulta apólices e status. Criticidade padrão da família: HIGH (o administrador pode alterar em Configurações, parâmetro integration.catalog.criticality.INSURANCE); a criticidade define a meta de sucesso (SLO), o prazo para considerar a sincronização parada e a severidade dos alertas. Efeito de uma queda: Cotações e propostas de seguro não andam; apólices podem vencer sem renovação.

## 2. Sintomas e alertas

- Alerta PROVIDER_DOWN ou CIRCUIT_OPEN da seguradora.
- Propostas em UNKNOWN ou sem retorno.
- Erros de validação da seguradora em lote.
- Como é um simulador local, falhas aqui indicam defeito do sistema ou do cenário de teste, não do fornecedor: conferir o ambiente do laboratório antes de acionar qualquer pessoa externa.

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Abrir Integrações > Saúde e localizar a linha do fornecedor insurance-manual: conferir o estado de saúde (HEALTHY, DEGRADED, DOWN ou UNKNOWN), o estado do circuito (CLOSED, OPEN ou HALF_OPEN) e a taxa de sucesso da última hora.
2. Consultar GET /v1/admin/integrations/insurance-manual/health para ver o último teste de saúde ativo (momento, resultado e latência), a série de métricas e a cota restante.
3. Abrir a fila de erros de integração (GET /v1/admin/integrations/errors) filtrada pelo fornecedor e ler a classe do erro mais recente: TRANSIENT e UNKNOWN indicam problema do fornecedor ou da rede; AUTH indica credencial; VALIDATION indica dado nosso; RATE_LIMIT indica cota.
4. Se o circuito estiver OPEN, anotar quando abriu e o tempo de espera (cooldown): as chamadas não essenciais esperam esse tempo sem gastar tentativa e só as essenciais seguem.
5. Conferir a fila de envios do fornecedor (pendentes, em nova tentativa, fila morta) e se há envios em UNKNOWN, que precisam de consulta antes de repetir.
6. Conferir os logs do laboratório e o cenário de teste em uso; o simulador não tem página de status.
7. Se a causa for credencial (AUTH), seguir a seção 5; se for cota, aguardar a renovação informada no painel; se for dado nosso (VALIDATION), corrigir o cadastro de origem e reenviar pela fila de erros.
8. Tarefa vencida: conferir em Compras, Seguros, as tarefas abertas com prazo no passado (GET /v1/procurement/insurance-tasks?status=OPEN), cobrar o responsável pelo e-mail ou portal da seguradora e, se o pedido mudou, cancelar a tarefa. Concluir uma tarefa de apólice exige o documento anexado (o hash é gravado) e a vigência.

## 4. Contingência

A família Seguradoras e garantias não tem modo de contingência próprio no livro: o fluxo manual é, ele mesmo, a alternativa quando a seguradora não tem API. Para uma seguradora com API fora do ar, trocar a seleção para o fluxo manual em Configurações mantém o mesmo modelo e os mesmos eventos; as propostas em UNKNOWN da seguradora anterior continuam reconciliando pela chave. Referência: M9-D238.

## 5. Como rotacionar credencial

O fluxo manual não usa credencial: não há segredo a rotacionar. A única credencial envolvida é a de quem conclui as tarefas (o login e as permissões de Compras de cada pessoa).

## 6. Quem acionar

Responsável por seguros e contratos da empresa e administrador de integrações. As pessoas são as que ocupam essas funções na empresa no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar ao administrador de integrações e à diretoria.

## 7. Como validar a recuperação

As tarefas abertas estão com responsável e prazo, as concluídas geraram a cotação ou a apólice com o documento e o hash, e os eventos de cotação recebida, apólice emitida e marcos de vencimento saíram com a origem MANUAL. Registrar o horário de normalização e, se houve atraso, abrir o registro correspondente no módulo de negócio afetado. O alerta se resolve sozinho quando a condição some e avisa a recuperação.
