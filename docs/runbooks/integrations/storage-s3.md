# Runbook da integração storage-s3

Família: Armazenamento de objetos (STORAGE). Qualquer serviço de armazenamento de objetos compatível com S3 (AWS S3, MinIO, Cloudflare R2 e semelhantes), ligado pela configuração da integração: endereço, região, bucket e estilo de endereçamento. A conta real é configuração da empresa, não código.

## 1. O que é e criticidade

Guarda os arquivos no bucket configurado, com cifra em repouso do próprio serviço (SSE AES256), as chaves sempre sob company/<id da empresa>/ e o hash SHA-256 de cada objeto nos metadados; emite endereços temporários assinados (SigV4) com validade máxima de integration.storage.signed_url_max_ttl_s. Criticidade padrão da família: HIGH (o administrador pode alterar em Configurações, parâmetro integration.catalog.criticality.storage). Efeito de uma queda: arquivos novos não são gravados e os existentes não podem ser lidos.

## 2. Sintomas e alertas

- Alerta PROVIDER_DOWN ou CIRCUIT_OPEN da família de armazenamento; erros 5xx ou de tempo esgotado do serviço.
- Erros 401 ou 403 do serviço (credencial recusada ou sem permissão no bucket): alerta AUTH_FAILURE.
- 409 INTEGRATION_STORAGE_INTEGRITY_VIOLATION: o objeto lido não confere com o hash gravado.
- Endereços temporários que expiram antes do uso (relógio do servidor fora de hora ou validade muito curta).

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Abrir Integrações > Saúde e localizar storage-s3: conferir saúde, circuito e taxa de sucesso da última hora.
2. Consultar GET /v1/admin/integrations/storage-s3/health e a fila de erros de integração filtrada pelo fornecedor; ler a classe do erro mais recente: TRANSIENT indica serviço ou rede; AUTH indica credencial ou política do bucket; VALIDATION indica requisição nossa.
3. Conferir no painel do serviço se o bucket existe, se a região e o endereço da integração batem e se a política da chave permite ler, gravar, apagar e consultar objetos sob company/.
4. Conferir se o endereço do serviço está na lista de saída permitida da integração (policy.egressHosts); host fora da lista é bloqueado pela política de saída antes de qualquer chamada.
5. Conferir a hora do servidor: assinatura SigV4 com relógio muito defasado é recusada pelo serviço.
6. Se o circuito estiver OPEN, anotar quando abriu e o tempo de espera; as chamadas não essenciais esperam sem gastar tentativa.

## 4. Contingência

A família STORAGE não tem modo de contingência próprio no livro. Se o serviço ficar indisponível, ativar em Integrações o driver de disco local (storage-local-disk) ou outra integração de armazenamento: os arquivos novos passam a ser gravados nele e os módulos de negócio não mudam. Os arquivos já gravados no serviço voltam a ser lidos quando ele normaliza; nada é apagado durante a falha.

## 5. Como rotacionar credencial

Gerar uma nova chave de acesso no painel do serviço (com permissão restrita ao bucket e ao prefixo company/), gravar a nova versão no cofre pela rotação da integração (tela Integrações, ação Rotacionar segredo, com MFA; o segredo é um JSON com accessKeyId e secretAccessKey) e conferir que a janela de graça mantém a versão anterior por alguns minutos. Depois de validar o teste de conexão, desativar a chave antiga no serviço. Nunca colar o segredo em chat, ticket ou arquivo: ele só trafega pelo cofre. O vencimento é avisado com 30, 14 e 7 dias de antecedência (alerta SECRET_EXPIRING); credencial vencida coloca a integração em AUTH_FAILED e pausa os envios.

## 6. Quem acionar

Administrador de infraestrutura (conta e bucket do serviço) e administrador de integrações (credencial e configuração da integração). As pessoas são as que ocupam essas funções no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar à diretoria.

## 7. Como validar a recuperação

O teste de saúde volta a ok por três verificações seguidas, o circuito fecha, um arquivo de teste é gravado, baixado e tem o hash conferido, e um endereço temporário de teste abre e expira no prazo. Registrar o horário de normalização e, se algum upload falhou durante a queda, pedir que o usuário reenvie o arquivo.
