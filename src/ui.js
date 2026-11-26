// Small DOM toolkit: element builder, toasts, modals, context menus.
// All user/repo text goes through textContent — never innerHTML — so repo content can't inject script.

/**
 * el('div.cls#id', { onclick, title, ... }, ...children)
 * Children: strings (text nodes), nodes, arrays, or falsy (skipped).
 */
export function el(spec, props = {}, ...children) {
  const [tag, ...rest] = spec.split(/(?=[.#])/);
  const node = document.createElement(tag || 'div');
  for (const r of rest) {
    if (r[0] === '.') node.classList.add(r.slice(1));
    else node.id = r.slice(1);
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (node, ...children) => {
  node.replaceChildren();
  append(node, children);
  return node;
};

// ---------- toasts ----------

const toasts = () => document.getElementById('toasts');

export function toast(message, { kind = 'info', detail, ms = kind === 'error' ? 9000 : 3500 } = {}) {
  const t = el('div.toast.' + kind, {}, el('div.toast-msg', {}, message));
  if (detail && detail.trim() && detail.trim() !== message.trim()) {
    const pre = el('pre.toast-detail', { hidden: true }, detail.trim());
    t.append(el('button.link', { onclick: () => (pre.hidden = !pre.hidden) }, 'Details'), pre);
  }
  t.addEventListener('click', (e) => e.target === t && t.remove());
  toasts().append(t);
  let timer = setTimeout(() => t.remove(), ms);
  t.addEventListener('mouseenter', () => clearTimeout(timer));
  t.addEventListener('mouseleave', () => (timer = setTimeout(() => t.remove(), 2500)));
}

export function toastError(e, prefix = '') {
  const msg = e?.message ?? String(e);
  const first = msg.split('\n').find((l) => l.trim()) ?? msg;
  toast((prefix ? prefix + ': ' : '') + first.replace(/^(error|fatal|hint):\s*/i, ''), {
    kind: 'error',
    detail: msg,
  });
}

// ---------- modals ----------

/** Shows a modal; `build(close)` returns the body. Resolves with whatever close() is given. */
export function modal(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const back = el('div.modal-back');
    const close = (v) => {
      back.remove();
      prev?.focus?.();
      resolve(v);
    };
    const box = el('div.modal' + (wide ? '.wide' : ''), { role: 'dialog' }, el('h2', {}, title), build(close));
    back.append(box);
    back.addEventListener('mousedown', (e) => e.target === back && close(null));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    });
    document.body.append(back);
    (box.querySelector('[autofocus]') ?? box.querySelector('input,textarea,select,button'))?.focus();
  });
}

/** fields: [{ name, label, value, type: 'text'|'textarea'|'checkbox'|'select', options }] */
export function form(title, fields, { ok = 'OK', danger = false, message } = {}) {
  return modal(title, (close) => {
    const inputs = {};
    const submit = (e) => {
      e?.preventDefault();
      const out = {};
      for (const [k, i] of Object.entries(inputs)) out[k] = i.type === 'checkbox' ? i.checked : i.value;
      close(out);
    };
    const rows = fields.map((f, i) => {
      let input;
      if (f.type === 'textarea') input = el('textarea', { rows: 4, value: f.value ?? '' });
      else if (f.type === 'select')
        input = el('select', {}, f.options.map((o) => el('option', { value: o, selected: o === f.value }, o)));
      else input = el('input', { type: f.type ?? 'text', value: f.value ?? '', checked: !!f.value, spellcheck: false });
      if (i === 0) input.autofocus = true;
      inputs[f.name] = input;
      return f.type === 'checkbox'
        ? el('label.check', {}, input, f.label)
        : el('label.field', {}, el('span', {}, f.label), input);
    });
    return el('form', { onsubmit: submit, onkeydown: (e) => e.key === 'Enter' && e.ctrlKey && submit(e) },
      message && el('p.msg', {}, message),
      rows,
      el('div.modal-btns', {},
        el('button.btn', { type: 'button', onclick: () => close(null) }, 'Cancel'),
        el('button.btn.primary' + (danger ? '.danger' : ''), { type: 'submit' }, ok)));
  });
}

export async function prompt(title, label, value = '', ok = 'OK') {
  const r = await form(title, [{ name: 'v', label, value }], { ok });
  return r?.v?.trim() || null;
}

export async function confirm(title, message, { ok = 'OK', danger = false } = {}) {
  return (await form(title, [], { ok, danger, message })) !== null;
}

// ---------- context menu ----------

/** items: [{ label, run, danger, disabled, hint } | '-' ] */
export function menu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  closeMenu();
  const m = el('div.menu#ctx-menu', { role: 'menu' });
  for (const it of items.filter(Boolean)) {
    if (it === '-') {
      if (m.lastChild && !m.lastChild.classList.contains('sep')) m.append(el('div.sep'));
      continue;
    }
    m.append(el('button.menu-item' + (it.danger ? '.danger' : ''), {
      disabled: it.disabled,
      onclick: () => {
        closeMenu();
        it.run();
      },
    }, el('span', {}, it.label), it.hint && el('span.hint', {}, it.hint)));
  }
  if (m.lastChild?.classList.contains('sep')) m.lastChild.remove();
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(event.clientX, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(event.clientY, innerHeight - r.height - 4) + 'px';
}

export function closeMenu() {
  document.getElementById('ctx-menu')?.remove();
}
addEventListener('mousedown', (e) => !e.target.closest?.('#ctx-menu') && closeMenu());
addEventListener('blur', closeMenu);
addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

export function copy(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('Copied'),
    (e) => toastError(e, 'Copy failed'),
  );
}
