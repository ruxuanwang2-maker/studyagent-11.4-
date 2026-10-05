let owner = null, timer = null, generation = 0, host = null, pendingGeneration = null;
export function mountImportStatus({ api, userId, english = false, openSource }) {
  if (owner !== userId) { generation++; clearTimeout(timer); timer = null; owner = userId; host?.remove(); host = null; }
  const token = generation;
  if (timer || pendingGeneration === token) return;
  const labels = english ? { queued:'Queued',running:'Processing',failed:'Failed',completed:'Imported' } : { queued:'等待解析',running:'正在处理',failed:'导入失败',completed:'已导入' };
  async function poll() {
    pendingGeneration = token;
    try {
      const { jobs = [] } = await api('/api/imports');
      if (token !== generation) return;
      const dismissed = new Set(JSON.parse(localStorage.getItem(`studyagent-import-dismissed:${userId}`) || '[]'));
      const visible = jobs.filter(job => !dismissed.has(job.id) && (['queued','running'].includes(job.status) || Date.now() - Date.parse(job.updatedAt) < 30 * 60000));
      if (!host) { host = document.createElement('aside'); host.className = 'import-status-panel'; host.setAttribute('aria-live','polite'); document.body.append(host); }
      host.replaceChildren(); host.hidden = !visible.length;
      for (const job of visible.slice(0,4)) {
        const row = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('small');
        title.textContent = job.filename;
        detail.textContent = `${labels[job.status] || job.status} · ${job.progress?.stage || ''}${job.progress?.total ? ` ${job.progress.page}/${job.progress.total}` : ''}${job.error ? ` · ${job.error.message}` : ''}`;
        row.append(title,detail);
        if (job.status === 'completed' && job.documentId) { const open = document.createElement('button'); open.textContent = english ? 'Open' : '打开'; open.className = 'tiny-btn'; open.onclick = () => openSource(job.documentId,1); row.append(open); }
        if (['completed','failed'].includes(job.status)) { const dismiss = document.createElement('button'); dismiss.textContent = english ? 'Dismiss' : '收起'; dismiss.className = 'tiny-btn'; dismiss.onclick = () => { dismissed.add(job.id); localStorage.setItem(`studyagent-import-dismissed:${userId}`,JSON.stringify([...dismissed].slice(-100))); row.remove(); if (!host.children.length) host.hidden = true; }; row.append(dismiss); }
        host.append(row);
      }
      timer = setTimeout(() => { timer = null; if (token === generation) poll(); }, jobs.some(job => ['queued','running'].includes(job.status)) ? 2000 : 10000);
    } catch { if (token === generation) timer = setTimeout(() => { timer = null; poll(); },10000); }
    finally { if (pendingGeneration === token) pendingGeneration = null; }
  }
  poll();
}
