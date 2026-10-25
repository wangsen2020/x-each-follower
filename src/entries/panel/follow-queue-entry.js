import {mountFollowQueuePanel} from './follow-queue-panel.js';

let mounted;
let generation = 0;
const request = message => chrome.runtime.sendMessage(message);

export async function openFollowQueue(root) {
  const current = ++generation;
  mounted?.destroy(); mounted = null;
  root.replaceChildren();
  const card = document.createElement('div'); card.className = 'queue-onboarding';
  const heading = document.createElement('strong'); heading.textContent = '正在为你准备关注队列';
  const note = document.createElement('p'); note.setAttribute('role','status'); note.setAttribute('aria-live','polite');
  note.textContent = '1 / 3 · 正在识别当前浏览器中的 X 账号…';
  const explanation = document.createElement('p');
  explanation.textContent = '无需手动打开页面。必要时会自动打开一个后台 X 标签页，读取完成后关闭；不会自动关注或发布。';
  card.append(heading,note,explanation); root.append(card);
  const stages = {checking:'1 / 3 · 正在检查现有 X 页面…',opening:'2 / 3 · 已自动打开 X 标签页，正在等待账号加载…',initializing:'3 / 3 · 正在初始化账号连接，即将完成…'};
  let pollBusy = false;
  const poll = setInterval(async()=>{
    if (pollBusy || current !== generation || !card.isConnected) return;
    pollBusy = true;
    try { const result = await request({cmd:'followQueueIdentityStatus'}); if(current === generation && stages[result?.stage]) note.textContent = stages[result.stage]; }
    catch {} finally { pollBusy = false; }
  }, 800);
  try {
    const identity = await request({cmd:'followQueueIdentity'});
    clearInterval(poll);
    if (current !== generation) return;
    if (!identity?.ok) throw new Error(identity?.error || '无法读取 X 账号');
    const setup = document.createElement('div'); setup.className = 'follow-queue-setup';
    const title = document.createElement('strong'); title.textContent = `队列账号：@${identity.handle}`; setup.append(title);
    const checks = {};
    for (const [key,label] of [['fans','粉丝跟进'],['mutual','互关追踪'],['comments','评论追踪']]) {
      const item = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
      input.checked = !identity.binding?.activated || (identity.binding?.accountId === identity.accountId && identity.binding?.sources?.[key] === true);
      checks[key] = input; item.append(input,document.createTextNode(label)); setup.append(item);
    }
    const confirmLabel = document.createElement('label'), confirm = document.createElement('input'); confirm.type = 'checkbox';
    confirmLabel.append(confirm,document.createTextNode('确认本地候选数据属于此账号')); setup.append(confirmLabel);
    const activate = document.createElement('button'); activate.textContent = '确认来源并接入队列'; setup.append(activate);
    const help = document.createElement('p');
    help.textContent = '账号已识别。下一步：选择候选来源 → 确认数据属于此账号 → 点击接入队列。没有候选时，先在粉丝跟进、互关追踪或评论追踪收集用户。接入后可在队列齿轮设置中配置并开启定时调度，默认不会自动关注或发布。';
    const status = document.createElement('p'); status.setAttribute('role','status');
    const content = document.createElement('div');
    root.replaceChildren(setup,help,status,content);
    const mount = () => { mounted?.destroy(); mounted = mountFollowQueuePanel(content,{request,accountId:identity.accountId}); };
    if (identity.binding?.activated && identity.binding.accountId === identity.accountId) mount();
    activate.addEventListener('click',async()=>{
      if (!confirm.checked) { status.textContent = '请先确认本地数据的账号归属。'; return; }
      if (!Object.values(checks).some(input => input.checked)) { status.textContent = '请至少选择一个候选来源。'; return; }
      activate.disabled = true;
      status.textContent = '正在确认账号并接入来源；首次恢复较多候选时需要一些时间，请稍候…';
      try {
        const response = await request({cmd:'followQueueActivate',accountId:identity.accountId,confirmed:true,
          sources:Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,v.checked]))});
        if (!response?.ok) throw new Error(response?.error || '接入失败');
        if (current !== generation) return;
        status.textContent = '已接入统一队列，原模块定时关注已停止。'; mount();
      } catch(error) { status.textContent = error.message; }
      finally { activate.disabled = false; }
    });
  } catch(error) {
    if (current !== generation) return;
    heading.textContent = '自动识别暂未完成';
    note.textContent = error.message;
    explanation.textContent = '请点击“打开 X 完成登录”，确认在这个浏览器配置中已登录且首页可正常显示；完成后返回此页，点击“重新识别账号”。若 X 显示网络错误，请先恢复连接再重试。';
    const login = document.createElement('button'); login.type = 'button'; login.textContent = '打开 X 完成登录';
    login.addEventListener('click', async()=>{
      login.disabled = true;
      try { await chrome.tabs.create({url:'https://x.com/home',active:true}); }
      catch { note.textContent = '未能打开 X，请手动在当前浏览器打开 https://x.com/home 完成登录。'; }
      finally { login.disabled = false; }
    });
    const retry = document.createElement('button');
    retry.type = 'button'; retry.textContent = '重新识别账号';
    retry.addEventListener('click', () => openFollowQueue(root));
    card.append(login,retry); root.replaceChildren(card);
    return {ok:false, error:error.message || '无法读取 X 账号'};
  } finally { clearInterval(poll); }
  return {ok:true};
}
