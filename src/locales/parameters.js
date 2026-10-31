// Complete sentences let translators reorder values without changing UI code.
const rows={
 demoData:['示例数据','Demo data','Dados de exemplo','Datos de ejemplo'],
 recordCount:['{{count}} 条','{{count}} records','{{count}} registros','{{count}} registros'],
 verifiedSession:['已验证 · {{session}}','Verified · {{session}}','Verificado · {{session}}','Verificado · {{session}}'],
 nextRun:['下次 {{time}}','Next: {{time}}','Próxima: {{time}}','Próxima: {{time}}'],
 batchLimit:['每批最多 {{count}} 帖','Up to {{count}} posts per batch','Até {{count}} posts por lote','Hasta {{count}} publicaciones por lote'],
 replyLimits:['每轮 {{perRun}} 条 · 每日 {{daily}} 条','{{perRun}} per run · {{daily}} per day','{{perRun}} por rodada · {{daily}} por dia','{{perRun}} por ronda · {{daily}} por día'],
 pageSummary:['第 {{page}} 页 · 共 {{total}} 条','Page {{page}} · {{total}} records','Página {{page}} · {{total}} registros','Página {{page}} · {{total}} registros'],
 pageNumber:['第 {{page}} 页','Page {{page}}','Página {{page}}','Página {{page}}'],
 selectedCount:['已选 {{count}} 条','Selected: {{count}}','Selecionados: {{count}}','Seleccionados: {{count}}'],
 selectPost:['选择 @{{handle}} 的帖子','Select post by @{{handle}}','Selecionar post de @{{handle}}','Seleccionar publicación de @{{handle}}'],
 replyWeight:['评论权重 {{weight}}','Reply priority: {{weight}}','Prioridade da resposta: {{weight}}','Prioridad de respuesta: {{weight}}'],
 reusedReply:['复用原帖 {{post}} 的评论正文','Reusing reply from post {{post}}','Reutilizando resposta do post {{post}}','Reutilizando respuesta de la publicación {{post}}'],
 minimumInterval:['{{phase}}最短间隔','{{phase}}: minimum interval','{{phase}}: intervalo mínimo','{{phase}}: intervalo mínimo'],
 maximumInterval:['{{phase}}最长间隔','{{phase}}: maximum interval','{{phase}}: intervalo máximo','{{phase}}: intervalo máximo'],
 openPost:['打开 @{{handle}} 的原帖','Open original post by @{{handle}}','Abrir post original de @{{handle}}','Abrir publicación original de @{{handle}}'],
 wisdomVersion:['参考智慧 v{{version}}','Knowledge reference v{{version}}','Referência de conhecimento v{{version}}','Referencia de conocimiento v{{version}}'],
 deleteTag:['删除标签 {{tag}}','Remove tag {{tag}}','Remover hashtag {{tag}}','Eliminar hashtag {{tag}}'],
 tagPreview:['候选 {{count}}/10 · 随机示例：','Selected {{count}}/10 · Random example: ','Selecionadas {{count}}/10 · Exemplo aleatório: ','Seleccionadas {{count}}/10 · Ejemplo aleatorio: '],
 priorityHelp:['按最近采集的关注状态计算。已打标且未关注：1000 +（评论×1 + 转发×3 + 点赞×3 + 收藏×3）% 1000；其他帖子不加权。综合分：{{score}}。同权重按尝试时间、采集时间排序。','Uses the latest collected follow status. Tagged posts from accounts you do not follow: 1000 + (replies × 1 + reposts × 3 + likes × 3 + bookmarks × 3) % 1000. Other posts receive no extra weight. Engagement score: {{score}}. Ties are sorted by attempt time, then collection time.','Usa o status de seguimento da última coleta. Posts classificados de contas que você não segue: 1000 + (respostas × 1 + reposts × 3 + curtidas × 3 + itens salvos × 3) % 1000. Os demais não recebem peso extra. Pontuação: {{score}}. Empates seguem o horário da tentativa e depois o da coleta.','Usa el estado de seguimiento de la última recopilación. Publicaciones clasificadas de cuentas que no sigues: 1000 + (respuestas × 1 + reposts × 3 + me gusta × 3 + guardados × 3) % 1000. Las demás no reciben peso extra. Puntuación: {{score}}. Los empates se ordenan por hora de intento y luego de recopilación.']
};
export const parameters=Object.fromEntries(['zh-CN','en','pt-BR','es-419'].map((locale,index)=>[locale,Object.fromEntries(Object.entries(rows).map(([key,values])=>[key,values[index]]))]));
