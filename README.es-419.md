# XFollower · Gestión de seguidores · 4.48.2

<div align="right">
  <a href="./README.md">简体中文</a> ·
  <a href="./README.en.md">English</a> ·
  <a href="./README.pt-BR.md">Português (Brasil)</a> ·
  <a href="./README.es-419.md">Español (Latinoamérica)</a>
</div>

XFollower es una extensión local para el navegador, diseñada para X.com. Ayuda a gestionar la revisión de seguidores, las colas para seguir, el seguimiento de seguimientos recíprocos, las respuestas en la página de inicio, el seguimiento de publicaciones y una base de conocimiento de escritura local. Los datos permanecen en la base de datos de la extensión del perfil actual del navegador.

## Descarga

La descarga pública actual es la **4.48.2**.

- [Descargar el ZIP de XFollower 4.48.2](https://github.com/wangsen2020/x-each-follower/releases/download/4.48.2/XFollower-4.48.2.zip)
- [Checksums SHA256](https://github.com/wangsen2020/x-each-follower/releases/download/4.48.2/SHA256SUMS.txt)
- [Ver todos los Releases de GitHub](https://github.com/wangsen2020/x-each-follower/releases/latest)

Este repositorio público ahora es la entrada del producto, las descargas y los tutoriales. El código fuente y las compilaciones de desarrollo se mantienen en un repositorio privado separado. Se conservaron los Releases, las etiquetas y los archivos de descarga existentes. Los archivos Source ZIP/TAR que GitHub genera para etiquetas históricas todavía pueden contener el código de esos commits; esos archivos históricos no se reescribieron.

## Novedades de 4.48.2

- El progreso, los resultados y las acciones de recuperación de las respuestas de inicio aparecen en el diálogo de registros de comentarios. Al cerrarlo o presionar Esc, permanece oculto durante las actualizaciones.
- Al pasar el cursor o enfocar el ícono de registros, se muestra la cuenta regresiva en tiempo real y la hora del próximo comentario. Si la hora pasó sin ejecutarse, el estado indica que espera la programación.
- Mejora la identificación de textos de oración en las preferencias de interacción. Las revisiones de IA manuales y automáticas aplican las reglas locales existentes antes del envío a la IA y usan la cola de procesamiento existente cuando hay coincidencia.
- Conserva la recuperación de la programación y los reintentos limitados de 4.48.1. Después de tres verificaciones sin evidencia de publicación, el flujo configurado genera y envía un nuevo comentario.

## Instalación

1. Descarga el ZIP y extráelo en una carpeta estable cuyo nivel raíz contenga directamente `manifest.json`.
2. En Chrome o Edge, abre la página de extensiones, activa el modo de desarrollador y elige “Cargar descomprimida”.
3. Selecciona la carpeta extraída. Antes de actualizar, respalda el perfil del navegador y los datos locales de la extensión; no desinstales la extensión para actualizarla.

## Tutoriales

- [Índice de tutoriales de XFollower](./docs/使用指南/使用说明.md)
- [Instalación y primer uso](./docs/使用指南/01-安装与初次使用.md)
- [Gestión de seguidores y seguimiento recíproco](./docs/使用指南/02-粉丝管理与回关.md)
- [Cola para seguir](./docs/使用指南/08-关注队列.md)
- [Guía de funciones recientes](./docs/使用指南/61.%20近期功能图解教程_20261027_0919_wangsen.md)
- [Configuración local de Grok Bot](./docs/使用指南/84.%20Grok-Bot本地接入图解与分步引导_20261028_1534_wangsen.md)

Las capturas y los pasos permanecen en `docs/` y se pueden leer directamente en GitHub. No se incluye un sitio web o blog independiente porque no se verificó ninguno en los metadatos del repositorio; los enlaces de GitHub anteriores son las entradas públicas confirmadas.

## Alcance

- Listas de seguidores, filtros, revisión con IA, seguimiento recíproco y colas para seguir
- Seguimiento de relaciones mutuas, comentarios, respuestas en la página de inicio y preferencias de idioma
- Seguimiento de publicaciones, ranking de X, informes diarios y base de conocimiento de escritura
- Conexiones opcionales con AgentRelay local y Grok Bot Bridge
- Interfaz en chino simplificado, inglés, portugués brasileño y español latinoamericano

Las acciones de seguir, eliminar, responder y recopilar dependen de la configuración del usuario, la disponibilidad de los servicios y los límites de X. Un GitHub Release no equivale a una publicación en Chrome Web Store.
