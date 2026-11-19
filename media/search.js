// @ts-check
(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => /** @type {any} */ (document.getElementById(id));
  const q = $('q'), r = $('r'), inc = $('include'), exc = $('exclude');
  const results = $('results'), summary = $('summary'), details = $('details'), replaceRow = $('replace-row');
  const toggles = {
    caseSensitive: $('case'), wholeWord: $('word'), regex: $('regex'),
    preserveCase: $('pcase'), openOnly: $('openonly'), useExclude: $('useexclude'),
  };

  const st = {
    caseSensitive: false, wholeWord: false, regex: false, preserveCase: false, openOnly: false, useExclude: true,
    details: false, showReplace: false, collapsed: {}, ...(vscode.getState() || {}),
  };
  q.value = st.query || ''; r.value = st.replace || ''; inc.value = st.include || ''; exc.value = st.exclude || '';
  const save = () => vscode.setState({ ...st, query: q.value, replace: r.value, include: inc.value, exclude: exc.value });
  const syncUi = () => {
    details.hidden = !st.details;
    replaceRow.hidden = !st.showReplace;
    $('toggle-replace').classList.toggle('open', st.showReplace);
    for (const k of Object.keys(toggles)) toggles[k].classList.toggle('on', !!st[k]);
  };
  syncUi();

  let lastId = 0, files = [], total = 0, selected = /** @type {HTMLElement|null} */ (null);
  const opts = () => ({
    query: q.value, caseSensitive: st.caseSensitive, wholeWord: st.wholeWord, regex: st.regex,
    include: inc.value, exclude: exc.value, openOnly: st.openOnly, useExclude: st.useExclude,
    replace: r.value, preserveCase: st.preserveCase,
  });

  let timer;
  function search(now = false) {
    save();
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'search', opts: opts() }), now ? 0 : 250);
  }

  /* ---- Replacement preview (mirrors replacementFor in searchView.ts) ---- */
  function buildRegex() {
    let src = st.regex ? q.value : q.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (st.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    try { return new RegExp(src, 'u' + (st.caseSensitive ? '' : 'i')); } catch { return undefined; }
  }
  function preserveCase(orig, rep) {
    if (!rep) return rep;
    const hasCase = c => c.toUpperCase() !== c.toLowerCase();
    if (orig === orig.toUpperCase() && hasCase(orig)) return rep.toUpperCase();
    if (orig === orig.toLowerCase() && hasCase(orig)) return rep.toLowerCase();
    if (hasCase(orig[0]) && orig[0] === orig[0].toUpperCase()) return rep[0].toUpperCase() + rep.slice(1);
    return rep;
  }
  let previewRe;
  function replacement(matched) {
    let out = st.regex && previewRe ? matched.replace(previewRe, r.value.replace(/\\n/g, '\n').replace(/\\t/g, '\t')) : r.value;
    if (st.preserveCase) out = preserveCase(matched, out);
    return out;
  }
  const replacing = () => st.showReplace;

  /* ---- Inputs ---- */
  for (const [k, el] of Object.entries(toggles)) el.addEventListener('click', () => {
    st[k] = !st[k]; el.classList.toggle('on', st[k]);
    if (k === 'preserveCase') { save(); render(); r.focus(); return; }
    search(true);
    (k === 'openOnly' ? inc : k === 'useExclude' ? exc : q).focus();
  });
  $('more').addEventListener('click', () => { st.details = !st.details; syncUi(); save(); if (st.details) inc.focus(); });
  $('toggle-replace').addEventListener('click', () => { st.showReplace = !st.showReplace; syncUi(); save(); render(); (st.showReplace ? r : q).focus(); });
  $('replace-all').addEventListener('click', () => replaceAll());
  q.addEventListener('input', () => search());
  r.addEventListener('input', () => { save(); render(); });
  [inc, exc].forEach(el => el.addEventListener('input', () => search()));

  function replaceAll() { if (total) vscode.postMessage({ type: 'replace', opts: opts() }); }

  document.addEventListener('keydown', e => {
    if (e.altKey && (e.metaKey || e.ctrlKey) && e.key === 'Enter' && st.showReplace) { e.preventDefault(); replaceAll(); return; }
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const k = { KeyC: 'caseSensitive', KeyW: 'wholeWord', KeyR: 'regex', KeyP: 'preserveCase' }[e.code];
      if (k) { e.preventDefault(); toggles[k].click(); }
    }
  });
  [q, r, inc, exc].forEach(el => el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); search(true); }
    if (e.key === 'ArrowDown' && el !== r) { const first = results.querySelector('.row'); if (first) { e.preventDefault(); select(first, false); } }
  }));

  /* ---- Results tree ---- */
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const svg = d => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const FILE_ICON = svg('<path d="M4 1.5h5.5L13 5v9.5H4zM9.5 1.5V5H13"/>');
  const MD_ICON = svg('<rect x="1" y="3.5" width="14" height="9" rx="1.5"/><path d="M3.5 10.5v-5l2 2.5 2-2.5v5M11.5 5.5v5M9.8 8.8l1.7 1.7 1.7-1.7"/>');
  const ICON_REPLACE = svg('<path d="M3 4h5v4H3zM10 6h3.5M12 4.5 13.5 6 12 7.5M3 11h10.5M12 9.5l1.5 1.5-1.5 1.5"/>');
  const ICON_REPLACE_ALL = svg('<path d="M2 3.5h5v4H2zM2 10h5M9.5 5.5h4M11.5 3.5l2 2-2 2M9.5 12h4M11.5 10l2 2-2 2"/>');
  const ICON_CLOSE = svg('<path d="m4 4 8 8M12 4l-8 8"/>');
  const actionBtn = (icon, title, act) => { const b = el('button', 'act'); b.innerHTML = icon; b.title = title; b.dataset.act = act; return b; };

  function render() {
    previewRe = st.regex ? buildRegex() : undefined;
    $('replace-all').disabled = !total;
    const selKey = selected?.dataset.key;
    results.textContent = '';
    selected = null;
    files.forEach((f, fi) => {
      const group = el('div', 'group');
      group.classList.toggle('collapsed', !!st.collapsed[f.uri]);
      const head = el('div', 'row file');
      head.dataset.fi = String(fi); head.dataset.key = f.uri;
      const icon = el('span', 'ficon'); icon.innerHTML = /\.(md|markdown)$/i.test(f.name) ? MD_ICON : FILE_ICON;
      const acts = el('span', 'acts');
      if (replacing()) acts.append(actionBtn(ICON_REPLACE_ALL, 'Replace All (⇧⌘1)', 'replaceFile'));
      acts.append(actionBtn(ICON_CLOSE, 'Dismiss (⌫)', 'dismissFile'));
      head.append(el('span', 'chev'), icon, el('span', 'name', f.name), el('span', 'dir', f.dir), acts, el('span', 'badge', String(f.matches.length)));
      head.title = f.dir ? `${f.dir}/${f.name}` : f.name;
      group.append(head);
      const list = el('div', 'matches');
      f.matches.forEach((m, mi) => {
        const row = el('div', 'row match');
        row.dataset.fi = String(fi); row.dataset.mi = String(mi); row.dataset.key = `${f.uri}#${m.offset}`;
        const text = el('span', 'text');
        text.append(el('span', 'pre', m.before));
        if (replacing()) {
          const rep = replacement(m.full);
          text.append(el('del', '', m.text));
          if (rep) text.append(el('ins', '', rep));
        } else text.append(el('mark', '', m.text));
        text.append(el('span', 'post', m.after));
        const acts = el('span', 'acts');
        if (replacing()) acts.append(actionBtn(ICON_REPLACE, 'Replace (⇧⌘1)', 'replaceMatch'));
        acts.append(actionBtn(ICON_CLOSE, 'Dismiss (⌫)', 'dismissMatch'));
        row.append(text, acts);
        row.title = `${m.before}${m.text}${m.after}`.trim();
        list.append(row);
      });
      group.append(list);
      results.append(group);
    });
    if (selKey) {
      const again = [...results.querySelectorAll('.row')].find(x => x.dataset.key === selKey);
      if (again) { selected = again; again.classList.add('selected'); }
    }
  }
  function updateSummary(msg) {
    summary.classList.remove('error');
    const m = files.length;
    summary.textContent = !q.value ? '' : total === 0 ? (msg?.partial ? 'Searching…' : 'No results found. Review your settings for configured exclusions and check your gitignore files.')
      : `${total} result${total > 1 ? 's' : ''} in ${m} file${m > 1 ? 's' : ''}${msg?.limited ? ' - The result set only contains a subset of all matches.' : ''}`;
  }

  function toggleGroup(head) {
    const g = head.parentElement, f = files[+head.dataset.fi];
    g.classList.toggle('collapsed');
    if (g.classList.contains('collapsed')) st.collapsed[f.uri] = true; else delete st.collapsed[f.uri];
    save();
  }
  function select(row, open, preserveFocus = true) {
    selected?.classList.remove('selected');
    selected = row; row.classList.add('selected');
    row.scrollIntoView({ block: 'nearest' });
    results.focus();
    if (open && row.classList.contains('match')) {
      const f = files[+row.dataset.fi];
      vscode.postMessage({ type: 'open', uri: f.uri, match: f.matches[+row.dataset.mi], preserveFocus });
    }
  }
  function visibleRows() { return [...results.querySelectorAll('.row')].filter(x => x.offsetParent !== null); }

  /** Remove a file or match from the results (Dismiss) and keep a sensible selection. */
  function dismiss(row) {
    const rows = visibleRows(), i = rows.indexOf(row);
    const fi = +row.dataset.fi, f = files[fi];
    if (row.classList.contains('file')) { total -= f.matches.length; files.splice(fi, 1); }
    else { f.matches.splice(+row.dataset.mi, 1); total--; if (!f.matches.length) files.splice(fi, 1); }
    const next = rows[i + 1] && !rows[i + 1].isSameNode(row) ? rows[i + 1].dataset.key : rows[i - 1]?.dataset.key;
    if (selected === row) selected = null;
    render(); updateSummary();
    const target = [...results.querySelectorAll('.row')].find(x => x.dataset.key === next);
    if (target) select(target, false);
  }
  function replaceAt(row) {
    const f = files[+row.dataset.fi];
    vscode.postMessage({ type: 'replace', opts: opts(), uri: f.uri, match: row.classList.contains('match') ? f.matches[+row.dataset.mi] : undefined });
  }

  results.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */ (e.target);
    const row = t.closest('.row');
    if (!row) return;
    const act = t.closest('.act')?.dataset.act;
    if (act === 'dismissFile' || act === 'dismissMatch') { dismiss(row); return; }
    if (act === 'replaceFile' || act === 'replaceMatch') { replaceAt(row); return; }
    if (row.classList.contains('file')) { toggleGroup(row); select(row, false); }
    else select(row, true, false);
  });
  results.addEventListener('keydown', e => {
    if (!selected) return;
    const rows = visibleRows(), i = rows.indexOf(selected);
    const isFile = selected.classList.contains('file');
    if (e.key === 'ArrowDown' && i < rows.length - 1) { e.preventDefault(); select(rows[i + 1], false); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (i > 0) select(rows[i - 1], false); else { selected.classList.remove('selected'); selected = null; q.focus(); } }
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isFile) toggleGroup(selected); else select(selected, true, e.key === ' ');
    }
    else if (e.key === 'ArrowLeft' && isFile && !selected.parentElement.classList.contains('collapsed')) toggleGroup(selected);
    else if (e.key === 'ArrowRight' && isFile && selected.parentElement.classList.contains('collapsed')) toggleGroup(selected);
    else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); dismiss(selected); }
    else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '1' && replacing()) { e.preventDefault(); replaceAt(selected); }
  });

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'focus') { if (msg.query) { q.value = msg.query; search(true); } q.focus(); q.select(); return; }
    if (msg.type === 'focusReplace') { st.showReplace = true; syncUi(); save(); render(); if (msg.query) { q.value = msg.query; search(true); } r.focus(); r.select(); return; }
    if (msg.type === 'clear') { q.value = ''; r.value = ''; files = []; total = 0; render(); summary.textContent = ''; save(); q.focus(); return; }
    if (msg.type === 'collapseAll') { files.forEach(f => st.collapsed[f.uri] = true); save(); render(); return; }
    if (msg.type === 'expandAll') { st.collapsed = {}; save(); render(); return; }
    if (msg.id != null && msg.id < lastId) return;
    if (msg.id != null) lastId = msg.id;
    if (msg.type === 'searching') { summary.textContent = 'Searching…'; summary.classList.remove('error'); }
    if (msg.type === 'error') { files = []; total = 0; render(); summary.textContent = msg.message; summary.classList.add('error'); }
    if (msg.type === 'results') { files = msg.files; total = msg.total; render(); updateSummary(msg); }
  });

  if (q.value) search(true);
  q.focus();
})();
