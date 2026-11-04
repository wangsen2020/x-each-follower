# XFollower · Gestão de seguidores · 4.33.0

<div align="right">
  <a href="./README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.pt-BR.md">Português (Brasil)</a> ·
  <a href="./README.es-419.md">Español (Latinoamérica)</a>
</div>

O XFollower é uma extensão local para o navegador, voltada ao X.com. Ela ajuda a gerenciar revisão de seguidores, filas de seguir, monitoramento de retribuição, respostas na página inicial, acompanhamento de posts e uma base de conhecimento de escrita local. Os dados ficam no banco da extensão do perfil atual do navegador.

## Download

A versão pública disponível atualmente é a **4.33.0**.

- [Baixar o ZIP do XFollower 4.33.0](https://github.com/wangsen2020/x-each-follower/releases/download/4.33.0/XFollower-4.33.0.zip)
- [Checksums SHA256](https://github.com/wangsen2020/x-each-follower/releases/download/4.33.0/SHA256SUMS.txt)
- [Ver todos os Releases no GitHub](https://github.com/wangsen2020/x-each-follower/releases/latest)

Este repositório público agora é a entrada do produto, dos downloads e dos tutoriais. O código-fonte e os builds de desenvolvimento são mantidos em um repositório privado separado. Os Releases, tags e arquivos de download existentes foram preservados. Os Source ZIP/TAR gerados pelo GitHub para tags históricas ainda podem conter o código daquela época; esses arquivos históricos não foram reescritos.

## Instalação

1. Baixe o ZIP e extraia-o em uma pasta estável cujo nível raiz contenha diretamente `manifest.json`.
2. No Chrome ou Edge, abra a página de extensões, ative o modo de desenvolvedor e escolha “Carregar sem compactação”.
3. Selecione a pasta extraída. Antes de atualizar, faça backup do perfil do navegador e dos dados locais da extensão; não desinstale a extensão para atualizá-la.

## Tutoriais

- [Índice dos tutoriais do XFollower](./docs/使用指南/使用说明.md)
- [Instalação e primeiro uso](./docs/使用指南/01-安装与初次使用.md)
- [Gestão de seguidores e retribuição](./docs/使用指南/02-粉丝管理与回关.md)
- [Fila de seguir](./docs/使用指南/08-关注队列.md)
- [Guia das funcionalidades recentes](./docs/使用指南/61.%20近期功能图解教程_20261027_0919_wangsen.md)
- [Configuração local do Grok Bot](./docs/使用指南/84.%20Grok-Bot本地接入图解与分步引导_20261028_1534_wangsen.md)

As imagens e etapas permanecem em `docs/` e podem ser lidas diretamente no GitHub. Nenhum site ou blog separado é listado porque não foi verificado nos metadados do repositório; os links do GitHub acima são as entradas públicas confirmadas.

## Escopo

- Listas de seguidores, filtros, revisão por IA, retribuição e filas de seguir
- Rastreamento de relações mútuas, comentários, respostas na página inicial e preferências de idioma
- Acompanhamento de posts, ranking do X, relatórios diários e base de conhecimento de escrita
- Conexões opcionais com AgentRelay local e Grok Bot Bridge
- Interface em chinês simplificado, inglês, português do Brasil e espanhol latino-americano

Ações de seguir, remover, responder e coletar dependem das configurações do usuário, da disponibilidade dos serviços e dos limites do X. Um GitHub Release não é uma publicação na Chrome Web Store.

