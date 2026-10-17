import {mountFollowQueuePanel} from './follow-queue-panel.js';

let mounted;
let generation = 0;
const request = message => chrome.runtime.sendMessage(message);

export async function openFollowQueue(root) {
  const current = ++generation;
  mounted?.destroy(); mounted = null;
  root.replaceChildren();
  const note = document.createElement('p'); note.textContent = '正在确认当前 X 账号…'; root.append(note);
  try {
    const identity = await request({cmd:'followQueueIdentity'});
    if (current !== generation) return;
    if (!identity?.ok) throw new Error(identity?.error || '无法读取 X 账号');
    const setup = document.createElement('div'); setup.className = 'follow-queue-setup';
    const title = document.createElement('strong'); title.textContent = `队列账号：@${identity.handle}`; setup.append(title);
    const checks = {};
    for (const [key,label] of [['fans','粉丝管理'],['mutual','互关追踪'],['comments','评论追踪']]) {
      const item = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
      input.checked = identity.binding?.accountId === identity.accountId && identity.binding?.sources?.[key] === true;
      checks[key] = input; item.append(input,document.createTextNode(label)); setup.append(item);
    }
    const confirmLabel = document.createElement('label'), confirm = document.createElement('input'); confirm.type = 'checkbox';
    confirmLabel.append(confirm,document.createTextNode('确认本地候选数据属于此账号')); setup.append(confirmLabel);
    const activate = document.createElement('button'); activate.textContent = '确认来源并接入队列'; setup.append(activate);
    const help = document.createElement('p');
    help.textContent = '勾选的来源可参与统一关注队列。接入后原模块定时关注停止，周期、门槛与引用发布均在队列设置中控制。默认不开启定时或自动发布。';
    const status = document.createElement('p'); status.setAttribute('role','status');
    const content = document.createElement('div');
    root.replaceChildren(setup,help,status,content);
    const mount = () => { mounted?.destroy(); mounted = mountFollowQueuePanel(content,{request,accountId:identity.accountId}); };
    if (identity.binding?.activated && identity.binding.accountId === identity.accountId) mount();
    activate.addEventListener('click',async()=>{
      if (!confirm.checked) { status.textContent = '请先确认本地数据的账号归属。'; return; }
      activate.disabled = true;
      try {
        const response = await request({cmd:'followQueueActivate',accountId:identity.accountId,confirmed:true,
          sources:Object.fromEntries(Object.entries(checks).map(([k,v])=>[k,v.checked]))});
        if (!response?.ok) throw new Error(response?.error || '接入失败');
        if (current !== generation) return;
        status.textContent = '已接入统一队列，原模块定时关注已停止。'; mount();
      } catch(error) { status.textContent = error.message; }
      finally { activate.disabled = false; }
    });
  } catch(error) { if(current === generation) note.textContent = error.message; }
}
