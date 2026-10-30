# Runbook da integração storage-local-disk

Família: Armazenamento de objetos (STORAGE). Disco local do servidor: é o armazenamento que o sistema já usava para os arquivos (pasta de uploads, ou a pasta apontada pela variável UPLOADS_DIR), agora atrás do port de armazenamento. É o driver padrão quando a empresa não tem outra integração de armazenamento ativa.

## 1. O que é e criticidade

Guarda cada arquivo cifrado (AES-256-GCM, chave FILES_ENCRYPTION_KEY) e, ao lado dele, um arquivo de metadados com o hash do conteúdo original. Não fala com nenhum serviço externo. Criticidade padrão da família: HIGH (o administrador pode alterar em Configurações, parâmetro integration.catalog.criticality.storage). Efeito de uma queda: os arquivos deixam de ser gravados e lidos, e contratos, documentos de pessoas, laudos e anexos ficam indisponíveis.

## 2. Sintomas e alertas

- Erros 404 INTEGRATION_STORAGE_OBJECT_NOT_FOUND ou FILE_CONTENT_NOT_FOUND em arquivos que existem no cadastro.
- Erros 409 FILE_INTEGRITY_VIOLATION ou INTEGRATION_STORAGE_INTEGRITY_VIOLATION: o conteúdo no disco não confere com o hash gravado ou a cifra foi adulterada.
- Falhas de gravação (disco cheio, permissão) e aumento de erros na família STORAGE.
- Como o driver é local, falhas aqui indicam o servidor ou o volume de uploads, não um fornecedor externo.

Os alertas chegam pelo motor de notificações aos papéis configurados (parâmetros integration.alert.*) e cada um aponta para este documento. Alertas possíveis: PROVIDER_DOWN, ERROR_RATE_UP, AUTH_FAILURE, SECRET_EXPIRING, SYNC_STALLED e QUOTA_LOW.

## 3. Diagnóstico passo a passo

1. Abrir Integrações > Saúde e conferir a família de armazenamento; se não houver integração ativa, o driver padrão (parâmetro integration.storage.default_provider) está em uso.
2. No servidor, conferir se a pasta de uploads (UPLOADS_DIR) existe, tem espaço livre e permissão de escrita para o processo da API; em container, conferir se o volume persistente está montado, porque sem ele os arquivos somem a cada publicação.
3. Para integridade: comparar o hash do arquivo no cadastro com o do objeto; 409 de integridade com motivo CIPHER_AUTH_FAILED indica arquivo adulterado ou chave FILES_ENCRYPTION_KEY trocada; NO_CIPHER_MARKER indica arquivo substituído por texto puro; SHA256_MISMATCH indica conteúdo diferente do gravado. O incidente já fica na auditoria (files.integrity_violation).
4. Restaurar o arquivo a partir da cópia de segurança (script de backup do armazenamento) e repetir a leitura; nunca apagar o arquivo de metadados (.meta) sozinho.
5. Conferir os logs do servidor para o erro do sistema operacional (ENOSPC, EACCES) antes de qualquer outra ação.

## 4. Contingência

A família STORAGE tem criticidade HIGH e não tem modo de contingência próprio no livro: a leitura e a gravação dependem do disco. Enquanto o volume não volta, o sistema responde com erro em português e não perde o cadastro; o envio de arquivos pelo usuário deve ser refeito depois. Se houver uma segunda integração de armazenamento (por exemplo o serviço compatível com S3), ativá-la em Integrações passa a gravar os arquivos novos nela, sem alterar os módulos de negócio.

## 5. Como rotacionar credencial

O disco local não usa credencial de fornecedor. A chave de cifra dos arquivos (FILES_ENCRYPTION_KEY) é uma variável de ambiente do servidor: trocá-la sem recifrar os arquivos existentes torna os arquivos antigos ilegíveis, por isso a rotação exige janela combinada, cópia de segurança prévia e recifragem de todos os objetos antes de remover a chave anterior.

## 6. Quem acionar

Administrador de infraestrutura do sistema (volume, espaço e permissões do servidor) e administrador de integrações (troca de driver em Integrações). As pessoas são as que ocupam essas funções no momento; este runbook não guarda nomes nem telefones. Se a função estiver vaga, escalar à diretoria.

## 7. Como validar a recuperação

Gravar e baixar um arquivo de teste pela tela de documentos: o conteúdo baixado é idêntico ao enviado e o hash confere. O teste de saúde da família volta a ok, nenhum erro de integridade novo aparece na auditoria por uma hora e a cópia de segurança do volume volta a rodar. Registrar o horário de normalização e os arquivos que precisaram ser restaurados.
