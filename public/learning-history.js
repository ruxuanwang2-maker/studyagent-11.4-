const escapeText = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));

export async function mountLearningHistory(host, { api, english = false, openSource }) {
  const words = english ? { title: 'Learning history', course: 'All courses', period: 'All dates', recent: 'Recent', days: 'days', facts: 'Observed activity', inference: 'Interpretation, not a mastery claim', empty: 'No recorded activity yet.', mastery: 'Evidence-based learning state' } : { title: '学习记录', course: '全部课程', period: '全部日期', recent: '最近', days: '天', facts: '实际学习行为', inference: '学习整理（推断，不代表已掌握）', empty: '暂时没有学习记录。', mastery: '基于证据的学习状态' };
  host.innerHTML = `<div class="section-head"><h2>${words.title}</h2><div class="history-filters"><select aria-label="${words.course}" data-course><option value="">${words.course}</option></select><select aria-label="${words.period}" data-period><option value="0">${words.period}</option>${[1, 7, 31].map(days => `<option value="${days}">${words.recent} ${days} ${words.days}</option>`).join('')}</select></div></div><div data-history-content role="status">${english ? 'Loading…' : '正在读取持久化学习记录…'}</div>`;
  const courseSelect = host.querySelector('[data-course]');
  const periodSelect = host.querySelector('[data-period]');
  const content = host.querySelector('[data-history-content]');
  const labels = english ? { reading: 'Read page', annotation: 'Annotation', note: 'Note', question: 'Question', review: 'Review', quiz: 'Self-test', error: 'Error record', session_finished: 'Finished session' } : { reading: '阅读页面', annotation: '批注', note: '笔记', question: '提问', review: '复习', quiz: '自测', error: '错误记录', session_finished: '结束学习' };
  const stateLabels = { unassessed: '尚未评估', self_reported: '已有自评记录', needs_attention: '有待关注记录' };
  let revision = 0;
  async function reload() {
    const current = ++revision;
    content.textContent = english ? 'Loading…' : '正在读取…';
    try {
      const query = courseSelect.value ? `?courseId=${encodeURIComponent(courseSelect.value)}` : '';
      const [eventData, experienceData, masteryData] = await Promise.all([api(`/api/learning/events${query}`), api(`/api/learning/experiences${query}`), api(`/api/learning/mastery${query}`)]);
      if (!host.isConnected || current !== revision) return;
      const days = Number(periodSelect.value);
      const inPeriod = date => !days || new Date(date).getTime() >= Date.now() - days * 86400000;
      const seen = new Set();
      const events = (eventData.events || []).filter(event => {
        const key = `${event.event_type}:${event.source_id}`;
        if (seen.has(key) || !inPeriod(event.created_at)) return false;
        seen.add(key); return true;
      });
      const experiences = (experienceData.experiences || []).filter(item => inPeriod(item.created_at));
      const mastery = masteryData.concepts || [];
      content.innerHTML = `<div class="history-states"><h3>${words.mastery}</h3>${mastery.slice(0, 12).map(item => `<span class="tag" title="${escapeText(item.caveat)}">${escapeText(item.name)} · ${escapeText(english ? ({ unassessed: 'Not assessed', self_reported: 'Self-review recorded', needs_attention: 'Needs attention' }[item.learningStatus] || 'Not assessed') : stateLabels[item.learningStatus] || '尚未评估')} · ${english ? 'self-assessments' : '自评结果'} ${item.reviewCount}</span>`).join('') || `<p class="meta">${words.empty}</p>`}</div><h3>${words.facts}</h3><div class="learning-event-list">${events.map(event => {
        const evidence = event.evidence || {};
        const text = evidence.question || evidence.note || evidence.text || evidence.title || evidence.description || (evidence.page ? `${english ? 'Page' : '第'} ${evidence.page}${english ? '' : ' 页'}` : evidence.selfReported ? (evidence.correct ? (english ? 'Self-reported correct' : '自评：答对') : (english ? 'Self-reported incorrect' : '自评：需再复习')) : '');
        return `<article class="learning-event"><div><strong>${escapeText(labels[event.event_type] || event.event_type)}</strong><time>${escapeText(new Date(event.created_at).toLocaleString(english ? 'en-US' : 'zh-CN'))}</time></div><p>${escapeText(String(text).slice(0, 500))}</p>${event.document_id ? `<button class="tiny-btn" data-source="${escapeText(event.document_id)}" data-page="${Number(evidence.page || evidence.locator?.page || 1)}">${english ? 'Open source' : '返回原资料'}</button>` : ''}</article>`;
      }).join('') || `<p class="meta">${words.empty}</p>`}</div><h3>${words.inference}</h3>${experiences.slice(0, 20).map(item => `<article class="learning-event"><strong>${escapeText(item.title)}</strong><p>${escapeText(item.content)}</p><small>${escapeText(item.interpretation?.caveat || '')}</small></article>`).join('') || `<p class="meta">${words.empty}</p>`}`;
      content.querySelectorAll('[data-source]').forEach(button => button.addEventListener('click', () => openSource(button.dataset.source, Number(button.dataset.page) || 1)));
    } catch (error) { if (current === revision && host.isConnected) content.textContent = error.message; }
  }
  try {
    const courses = await api('/api/courses');
    if (!host.isConnected) return;
    for (const course of courses) courseSelect.add(new Option(course.name, course.id));
    courseSelect.addEventListener('change', reload);
    periodSelect.addEventListener('change', reload);
    await reload();
  } catch (error) { if (host.isConnected) content.textContent = error.message; }
}
