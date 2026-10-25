// Search is a view of a bounded local scan, not proof that the archive is empty.
export function followerEmptyView({keyword,count,hasMore}) {
  const searching=Boolean(String(keyword||'').trim());
  return {showEmpty:!searching&&!count,showList:searching||count>0,
    message:hasMore?'当前扫描范围暂无匹配，可点击下一页继续查找。':'没有匹配的账号。'};
}
