import type { FastifyInstance } from "fastify";

/** Progressive enhancement only: the native forms remain usable without JavaScript. */
export const UI_SCRIPT = String.raw`(() => {
  const all = (selector) => Array.from(document.querySelectorAll(selector));
  all('[data-live-status]').forEach((card) => {
    async function poll() {
      try {
        const response = await fetch('/dashboard/devices/' + encodeURIComponent(card.dataset.deviceId) + '/status', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        // Refresh status and recovery controls together, without interrupting edits.
        const editingName = all('input[name="name"]').some(input => input.value !== input.defaultValue);
        if (data.state !== card.dataset.state && !editingName && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) location.reload();
      } catch { /* Keep the page usable during network interruptions. */ }
    }
    void poll();
    setInterval(poll, 2500);
  });
  all('[data-copy]').forEach((button) => {
    const label = button.querySelector('[data-copy-label]');
    const original = label ? label.textContent : null;
    let timer;
    button.addEventListener('click', async () => {
      const text = button.dataset.copy;
      if (text === undefined) return;
      try {
        await navigator.clipboard.writeText(text);
        const copied = button.dataset.copiedLabel || original || '';
        if (label) label.textContent = copied;
        const notice = document.createElement('div');
        notice.className = 'toast in'; notice.textContent = copied;
        notice.setAttribute('role', 'status');
        const host = document.createElement('div'); host.className = 'toast-host';
        host.append(notice); document.body.append(host);
        clearTimeout(timer);
        timer = setTimeout(() => { if (label) label.textContent = original; }, 1500);
        setTimeout(() => host.remove(), 1500);
      } catch {
        const area = document.createElement('textarea');
        area.value = text; area.readOnly = true; area.className = 'input';
        area.setAttribute('aria-label', button.getAttribute('aria-label') || original || '');
        area.style.cssText = 'position:fixed;z-index:100;bottom:80px;left:16px;width:calc(100% - 32px);height:100px;padding:12px';
        document.body.append(area); area.focus(); area.select();
        area.addEventListener('blur', () => area.remove());
      }
    });
  });
  const clean = (text) => String(text).toUpperCase().replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, '');
  all('input[data-code-input]').forEach((input) => {
    const group = document.createElement('div'); group.className = 'code-cells';
    const labels = Array.from(input.labels || []);
    const initial = clean(input.value).slice(0, 8);
    const cells = [];
    for (let i = 0; i < 8; i++) {
      if (i === 4) { const dash = document.createElement('span'); dash.className = 'dash'; dash.setAttribute('aria-hidden', 'true'); group.append(dash); }
      const cell = document.createElement('input');
      cell.className = 'cell'; cell.type = 'text'; cell.maxLength = 1; cell.required = true;
      cell.id = (input.id || 'pairing-code') + '-' + (i + 1);
      cell.value = initial[i] || '';
      cell.setAttribute('aria-label', (input.dataset.cellLabel || '').replace('{index}', String(i + 1)));
      cell.setAttribute('autocomplete', i === 0 ? 'one-time-code' : 'off');
      cell.setAttribute('autocapitalize', 'characters'); cell.setAttribute('spellcheck', 'false');
      cell.setAttribute('pattern', '[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]');
      const hint = input.getAttribute('aria-describedby'); if (hint) cell.setAttribute('aria-describedby', hint);
      group.append(cell); cells.push(cell);
    }
    input.after(group); input.type = 'hidden'; input.required = false;
    labels.forEach((label) => { label.htmlFor = cells[0].id; });
    const focus = (i) => { cells[i].focus(); cells[i].select(); };
    const sync = () => {
      const text = cells.map((cell) => cell.value).join('');
      input.value = text.length === 8 ? text.slice(0, 4) + '-' + text.slice(4) : text;
      cells.forEach((cell) => cell.classList.toggle('filled', !!cell.value));
    };
    const fill = (text) => { const value = clean(text).slice(0, 8); cells.forEach((cell, i) => { cell.value = value[i] || ''; }); sync(); focus(Math.min(value.length, 7)); };
    cells.forEach((cell, i) => {
      cell.addEventListener('input', () => {
        const value = clean(cell.value);
        if (value.length > 1) { fill(value); return; }
        cell.value = value; sync(); if (value && i < 7) focus(i + 1);
      });
      cell.addEventListener('paste', (event) => { event.preventDefault(); fill(event.clipboardData.getData('text')); });
      cell.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !cell.value && i > 0) { event.preventDefault(); cells[i - 1].value = ''; sync(); focus(i - 1); }
        if (event.key === 'ArrowLeft' && i > 0) { event.preventDefault(); focus(i - 1); }
        if (event.key === 'ArrowRight' && i < 7) { event.preventDefault(); focus(i + 1); }
      });
    });
    const form = input.form;
    if (form) form.addEventListener('submit', (event) => { sync(); const empty = cells.findIndex((cell) => !cell.value); if (empty >= 0) { event.preventDefault(); focus(empty); } });
    sync();
  });
  all('[data-fill-target]').forEach((button) => button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.fillTarget);
    if (input) { input.value = button.textContent.trim(); input.focus(); }
  }));
  all('input[data-confirm-match]').forEach((input) => {
    const form = input.form; if (!form) return;
    const submits = Array.from(form.elements).filter((el) => el.type === 'submit');
    const update = () => submits.forEach((button) => { button.disabled = input.value !== input.dataset.confirmMatch; });
    input.addEventListener('input', update);
    form.addEventListener('submit', (event) => { if (input.value !== input.dataset.confirmMatch) { event.preventDefault(); input.focus(); } });
    update();
  });
})();`;

export function registerDashboardAssets(app: FastifyInstance): void {
  app.get("/dashboard/assets/ui.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").header("X-Content-Type-Options", "nosniff").send(UI_SCRIPT));
}
