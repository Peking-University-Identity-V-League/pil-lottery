// 在页面显示前选定语言。非中文页面先隐藏，翻译完成后由 i18n.js 显示，避免闪现中文。
(() => {
  const ids = ['zh', 'en', 'ja'];
  const root = document.documentElement;
  let lang = '';
  try {
    const saved = localStorage.getItem('pil-lottery:lang');
    if (ids.includes(saved)) lang = saved;
  } catch { /* 隐私模式等 */ }
  if (!lang) {
    const browser = (navigator.languages || [navigator.language]).map((tag) => String(tag).toLowerCase().split('-')[0]);
    lang = browser.find((id) => ids.includes(id)) || 'en';
  }
  root.dataset.lang = lang;
  if (lang === 'zh') return;
  root.lang = lang;
  root.classList.add('i18n-pending');
  // 脚本加载失败时也要显示页面
  setTimeout(() => root.classList.remove('i18n-pending'), 4000);
})();
