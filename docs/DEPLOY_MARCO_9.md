# Deploy do Marco 9 — ordem das migrations e da API

A API antiga (Marcos 3 a 8) tolera as migrations `20260101000650` a `20260101009963`. Os gatilhos de somente leitura do legado do Correspondente (`provider_accounts`, `integration_errors`, `webhook_inbox`) ficam na migration `20260101009964`, a última, e só podem ser aplicados quando a API do Marco 9 já estiver no ar (ela grava pelo registro de integração e define `app.integration_legacy_write='on'` quando precisa gravar no legado).

## Ordem

1. Backup novo imediatamente antes (`pg_dump -Fc`, com SHA-256), em `backups/` (ignorado pelo git).
2. Aplicar as migrations `20260101000650` a `20260101009963` (`npx sequelize-cli db:migrate --env migration --to 20260101009963-relatorio-saneamento-chaves-protegidas.js`). A API antiga continua funcionando.
3. Deploy da API e do Front do Marco 9 e conferir `/api/health` e `/api/version`.
4. Aplicar a `20260101009964-fecha-o-legado-com-gatilhos-somente-leitura.js` (`npx sequelize-cli db:migrate --env migration`). É idempotente.
5. Fumaça: criar e listar uma connection do registro, receber um webhook de financiamento sandbox, abrir o painel do Correspondente.

## Plano de reversão

- Antes do passo 4: `npx sequelize-cli db:migrate:undo:all --to 20260101000648-dimob-gatilho-congelamento-estrito.js --env migration` (as `down` das migrations aditivas derrubam apenas objetos novos). Se alguma `down` falhar, parar a API e restaurar o backup (`pg_restore --clean --if-exists --no-owner`).
- Depois do passo 4, se for preciso voltar à API antiga: desfazer só a última (`npx sequelize-cli db:migrate:undo --env migration`), que remove os três gatilhos, e então reimplantar a API antiga.
- A `009962` apaga linhas condicionais (permissão `integration:platform` e chaves `integration.*` gravadas por quem não é operador); a `down` não as restaura, só o backup.

## Observações conhecidas (documentadas, não corrigidas)

- As migrations `858` e `879` convertem o vocabulário de `classification` para LOW/MEDIUM/HIGH/RESTRICTED: `POST /properties/:id/media` com `PUBLIC` ou `INTERNAL` passa de 201 para 500 na API antiga. O Front não envia esse campo e os dados de homologação já estão no vocabulário aceito.
- A `009962` apaga só linhas da permissão `integration:platform` e de chaves `integration.*` gravadas por não operador; o `down` não restaura (só o backup).
- A D612 tenta criar o role `nayara_analytics_reader`; sem CREATEROLE ela trata o erro e segue (a API fica só com a transação READ ONLY).

## Ponto 5 do aceite (branch m9fix/ponto5-m9)

- Migration `20260101009966-pessoas-filhos-so-com-pessoa-da-mesma-empresa.js` (ISO-8, DI-M9R-1) entra no passo 4 com as demais (`npx sequelize-cli db:migrate --env migration`). Antes de criar as chaves compostas (contato, endereço, documento, papel e consentimento só com pessoa da MESMA empresa), ela imprime por tabela quantas linhas apontam para pessoa de outra empresa. Com zero (o esperado: a leitura de 10/11 achou zero nas 44 colunas `*person_id*`), cria as chaves. Com alguma, PARA sem alterar nada e lista as contagens: o destino desses dados é decisão de negócio; corrija e rode de novo. A API antiga já grava os filhos com a empresa da pessoa, então a ordem com o deploy da API não importa. Reversão: `npx sequelize-cli db:migrate:undo --env migration --name 20260101009966-pessoas-filhos-so-com-pessoa-da-mesma-empresa.js` (remove só as seis constraints).
- O bloqueio de envio da campanha passa a gravar `marketing.message.blocked` por destinatário (DI-M9R-2); sem migration.
- Depois do deploy, o reteste do ponto 5 é `scripts/homo/retestePonto5Marco9.js` (comando completo em `Maturacao/fechamento-m3-m6/m9-ponto5.md`). Rodar fora do horário de silêncio do Marketing (padrão 21:00 a 08:00) e com o cofre de segredos configurado, senão o e-mail do contato com opt-in (o controle positivo) não sai.
