# Runbook da integração signature-clicksign

Família: Assinatura digital (SIGNATURE). Fornecedor real de assinatura digital Clicksign: cria e acompanha envelopes e baixa o documento assinado por link validado contra SSRF.

## 1. O que é e criticidade

Fornecedor real de assinatura digital Clicksign: cria e acompanha envelopes e baixa o documento assinado por link validado contra SSRF. Cria envelopes de assinatura de contratos, acompanha o andamento, cancela e baixa o documento assinado com a evidência. Criticidade padrão da família: CRITICAL (o administrador pode alterar em Configurações, parâmetro integration.catalog.criticality.SIGNATURE); a criticidade define a meta de sucesso (SLO), o prazo para considerar a sincronização parada e a severidade dos alertas. Efeito de uma queda: Contratos não são enviados para assinatura ou ficam sem acompanhamento; prazos contratuais podem estourar.

## 2. Sintomas e alertas

- Alerta PROVIDER_DOWN, CIRCUIT_OPEN ou AUTH_FAILURE da assinatura.
- Envelopes parados em andamento sem novos eventos de webhook.
- Assinatura concluída no fornecedor sem aparecer no sistema.

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Abrir Integrações > Saúde e localizar a linha do fornecedor signature-clicksign: conferir o estado de saúde (HEALTHY, DEGRADED, DOWN ou UNKNOWN), o estado do circuito (CLOSED, OPEN ou HALF_OPEN) e a taxa de sucesso da última hora.
2. Consultar GET /v1/admin/integrations/signature-clicksign/health para ver o último teste de saúde ativo (momento, resultado e latência), a série de métricas e a cota restante.
3. Abrir a fila de erros de integração (GET /v1/admin/integrations/errors) filtrada pelo fornecedor e ler a classe do erro mais recente: TRANSIENT e UNKNOWN indicam problema do fornecedor ou da rede; AUTH indica credencial; VALIDATION indica dado nosso; RATE_LIMIT indica cota.
4. Se o circuito estiver OPEN, anotar quando abriu e o tempo de espera (cooldown): as chamadas não essenciais esperam esse tempo sem gastar tentativa e só as essenciais seguem.
5. Conferir a fila de envios do fornecedor (pendentes, em nova tentativa, fila morta) e se há envios em UNKNOWN, que precisam de consulta antes de repetir.
6. Conferir a página de status do próprio fornecedor e o contrato: se o fornecedor informa incidente, aguardar a normalização e não repetir operações perigosas.
7. Se a causa for credencial (AUTH), seguir a seção 5; se for cota, aguardar a renovação informada no painel; se for dado nosso (VALIDATION), corrigir o cadastro de origem e reenviar pela fila de erros.

## 4. Contingência

Modo de contingência da família: PRESERVE_AND_ALTERNATE_FLOW. O contrato e a evidência ficam preservados no sistema e o jurídico segue o fluxo alternativo (colher a assinatura por outro meio válido e anexar a evidência), sem presumir que o envelope foi assinado. Referência: M9-D227. A contingência é acionada quando o circuito abre, a integração perde a credencial, o teste de saúde marca DOWN ou não há conexão ativa, e é encerrada depois de verificações de saúde seguidas com sucesso, drenando a fila em ordem.

## 5. Como rotacionar credencial

Gerar o novo token no painel do fornecedor de assinatura, gravar a nova versão no cofre pela rotação da integração (com MFA), atualizar o segredo de assinatura dos webhooks e conferir um envelope de teste. Nunca colar o segredo em chat, ticket ou arquivo: ele só trafega pelo cofre. O vencimento da credencial é avisado com 30, 14 e 7 dias de antecedência (alerta SECRET_EXPIRING); credencial vencida coloca a integração em AUTH_FAILED e pausa os envios sem gastar tentativa até a reativação.

## 6. Quem acionar

Responsável pelo jurídico e contratos da empresa e administrador de integrações. As pessoas são as que ocupam essas funções na empresa no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar ao administrador de integrações e à diretoria.

## 7. Como validar a recuperação

O teste de saúde volta a ok, o circuito fecha, a consulta de cada envelope em andamento retorna o estado do fornecedor igual ao do sistema e um webhook de teste é aceito com assinatura válida. Registrar o horário de normalização e, se houve perda de dado ou atraso, abrir o registro correspondente no módulo de negócio afetado. O alerta se resolve sozinho quando a condição some e avisa a recuperação.
