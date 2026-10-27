// Approved Bridge prototype CSS; prototype-only controls excluded.
export const STYLES = String.raw`/* ================================================================
   Direction B · Bridge — light, journey-first, guided
   Principle: every screen answers "what's next"; the bridge shows
   how your computer, OpenRemote and ChatGPT are linked right now.
   ================================================================ */
:root {
  --bg: #f4f5f7;
  --panel: #ffffff;
  --panel-2: #fafbfc;
  --sunken: #f0f2f5;
  --line: #e5e7ec;
  --line-2: #d7dbe2;
  --text: #0e1116;
  --text-2: #4a5161;
  --text-3: #848a98;
  --text-4: #b4b9c4;
  --accent: #3355ff;
  --accent-hover: #2846e6;
  --accent-bg: #eef1ff;
  --accent-line: #c7d0ff;
  --ok: #0e9454; --ok-bg: #e7f6ee; --ok-line: #bfe5d0;
  --busy: #b26a00; --busy-bg: #fff3dc; --busy-line: #f2d7a2;
  --err: #d13838; --err-bg: #fdeded; --err-line: #f2c3c3;
  --off: #6b7280; --off-bg: #f0f1f4; --off-line: #dcdfe5;
  --win: #2563eb; --win-bg: #eaf1ff;
  --mac: #1d1d1f; --mac-bg: #f1f1f3;
  --lin: #b45309; --lin-bg: #fff4e3;
  --r-sm: 8px; --r: 12px; --r-lg: 16px; --r-xl: 22px;
  --sh-sm: 0 1px 2px rgba(14, 17, 22, .05);
  --sh: 0 1px 2px rgba(14, 17, 22, .04), 0 6px 18px -6px rgba(14, 17, 22, .08);
  --sh-lg: 0 2px 6px rgba(14, 17, 22, .04), 0 24px 56px -16px rgba(14, 17, 22, .16);
  --font: "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  --font-display: "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif;
  --mono: "Cascadia Mono", "Cascadia Code", "SF Mono", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
  --ease: cubic-bezier(.2, .8, .2, 1);
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body { background: var(--bg); color: var(--text); font: 15px/1.6 var(--font); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; }
.i { flex: none; display: block; }
.mono { font-family: var(--mono); font-size: .9em; letter-spacing: -.01em; }
.muted { color: var(--text-2); }
.faint { color: var(--text-3); }
::selection { background: #d6ddff; }
:focus-visible { outline: none; box-shadow: 0 0 0 3px #fff, 0 0 0 5px var(--accent-line); border-radius: var(--r-sm); }

/* ---------- Shell ---------- */
.nav { position: sticky; top: 0; z-index: 30; background: rgba(255, 255, 255, .86); backdrop-filter: saturate(1.4) blur(14px); border-bottom: 1px solid var(--line); }
.nav-in { max-width: 1180px; margin: 0 auto; height: 64px; padding: 0 28px; display: flex; align-items: center; gap: 28px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; font-size: 16px; letter-spacing: -.01em; }
.logo-tile { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; color: #fff; background: linear-gradient(160deg, #5370ff, #2442e0); box-shadow: 0 4px 12px -4px rgba(51, 85, 255, .55), inset 0 1px 0 rgba(255, 255, 255, .25); }
.tabs { display: flex; gap: 4px; height: 100%; }
.tabs a { position: relative; display: flex; align-items: center; padding: 0 12px; font-size: 14.5px; color: var(--text-2); transition: color .15s; }
.tabs a:hover { color: var(--text); }
.tabs a.on { color: var(--text); font-weight: 600; }
.tabs a.on::after { content: ""; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--text); }
.nav-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.avatar { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; flex: none; font-weight: 650; font-size: 14px; color: #fff; background: linear-gradient(140deg, #8a9bff, #3355ff); box-shadow: inset 0 0 0 2px rgba(255, 255, 255, .5); }
.avatar.lg { width: 52px; height: 52px; font-size: 20px; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 36px 28px 80px; }

/* ---------- Buttons ---------- */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid transparent; background: none; font-size: 14.5px; font-weight: 600; white-space: nowrap; cursor: pointer; transition: background .15s, border-color .15s, box-shadow .15s, transform .1s; }
.btn:active { transform: translateY(1px); }
.btn-primary { background: var(--accent); color: #fff; box-shadow: 0 1px 2px rgba(51, 85, 255, .3), inset 0 1px 0 rgba(255, 255, 255, .18); }
.btn-primary:hover { background: var(--accent-hover); }
.btn-dark { background: var(--text); color: #fff; }
.btn-dark:hover { background: #262a33; }
.btn-secondary { background: var(--panel); border-color: var(--line-2); color: var(--text); box-shadow: var(--sh-sm); }
.btn-secondary:hover { border-color: #c4c9d2; background: var(--panel-2); }
.btn-ghost { color: var(--text-2); }
.btn-ghost:hover { background: var(--sunken); color: var(--text); }
.btn-danger { color: var(--err); border-color: var(--err-line); background: var(--panel); }
.btn-danger:hover { background: var(--err-bg); }
.btn-danger-solid { background: var(--err); color: #fff; }
.btn-sm { height: 34px; padding: 0 12px; font-size: 13.5px; border-radius: 9px; }
.btn-lg { height: 50px; padding: 0 22px; font-size: 16px; border-radius: 13px; }
.btn-block { width: 100%; }
.btn-icon { width: 40px; padding: 0; }
.btn-sm.btn-icon { width: 34px; }
.btn[disabled] { opacity: .45; pointer-events: none; }
.link { color: var(--accent); font-weight: 550; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.link:hover { color: var(--accent-hover); }

/* ---------- Type & surfaces ---------- */
.eyebrow { margin: 0 0 8px; font-size: 14px; color: var(--text-3); font-weight: 550; display: flex; align-items: center; gap: 8px; }
.h1 { margin: 0; font: 680 34px/1.18 var(--font-display); letter-spacing: -.025em; }
.lead { margin: 10px 0 0; font-size: 16px; color: var(--text-2); max-width: 680px; }
.page-head { display: flex; align-items: flex-end; gap: 20px; margin-bottom: 28px; }
.page-head .actions { margin-left: auto; display: flex; gap: 10px; }
.section { margin-top: 40px; }
.section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
.section-head h2 { margin: 0; font: 650 19px/1.3 var(--font-display); letter-spacing: -.01em; }
.section-head .sub { color: var(--text-3); font-size: 14px; }
.section-head .right { margin-left: auto; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--sh); }
.card-pad { padding: 22px 24px; }
.card h3 { margin: 0; font-size: 16px; font-weight: 650; }
.row { display: flex; align-items: center; gap: 10px; }
.stack { display: flex; flex-direction: column; gap: 16px; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }
hr.rule { border: 0; border-top: 1px solid var(--line); margin: 0; }

/* ---------- Status ---------- */
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; position: relative; background: var(--off); }
.dot.ok { background: var(--ok); } .dot.busy { background: var(--busy); } .dot.err { background: var(--err); }
.dot.off { background: transparent; box-shadow: inset 0 0 0 1.6px var(--off); }
.dot.revoked { background: transparent; box-shadow: inset 0 0 0 1.6px var(--text-4); }
.dot.ok::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: var(--ok); opacity: .25; animation: breathe 2.4s ease-in-out infinite; }
.dot.busy::after { content: ""; position: absolute; inset: -3px; border-radius: 50%; background: var(--busy); opacity: .25; animation: breathe 1.1s ease-in-out infinite; }
@keyframes breathe { 0%, 100% { transform: scale(.7); opacity: .1; } 50% { transform: scale(1.35); opacity: .3; } }
.chip { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; border: 1px solid var(--line); background: var(--panel-2); color: var(--text-2); }
.chip.ok { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-line); }
.chip.busy { color: var(--busy); background: var(--busy-bg); border-color: var(--busy-line); }
.chip.err { color: var(--err); background: var(--err-bg); border-color: var(--err-line); }
.chip.off { color: var(--off); background: var(--off-bg); border-color: var(--off-line); }
.chip.revoked { color: var(--text-3); background: var(--panel); border-style: dashed; }
.chip.accent { color: var(--accent); background: var(--accent-bg); border-color: var(--accent-line); }
.chip.plain { font-weight: 500; }

/* OS tiles */
.os { width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center; flex: none; }
.os.win { color: var(--win); background: var(--win-bg); }
.os.mac { color: var(--mac); background: var(--mac-bg); }
.os.linux { color: var(--lin); background: var(--lin-bg); }
.os.unknown { color: var(--text-3); background: var(--sunken); }
.os.sm { width: 34px; height: 34px; border-radius: 10px; }
.os.xl { width: 64px; height: 64px; border-radius: 18px; }
.os.dim { filter: grayscale(1); opacity: .55; }

/* ---------- Bridge (hero visualization) ---------- */
.bridge { position: relative; padding: 30px 32px; overflow: hidden; }
.bridge::before { content: ""; position: absolute; inset: 0; background: radial-gradient(520px 200px at 50% 50%, rgba(51, 85, 255, .07), transparent 70%); pointer-events: none; }
.bridge-row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) minmax(48px, 120px) minmax(0, .9fr) minmax(48px, 120px) minmax(0, 1fr); align-items: center; }
.bnode { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; }
.bnode-icon { width: 64px; height: 64px; border-radius: 20px; display: grid; place-items: center; background: var(--panel); border: 1px solid var(--line); box-shadow: var(--sh); color: var(--text); position: relative; }
.bnode-icon .badge { position: absolute; top: -6px; right: -6px; min-width: 22px; height: 22px; padding: 0 6px; border-radius: 11px; display: grid; place-items: center; font: 700 12px/1 var(--font); color: #fff; background: var(--accent); box-shadow: 0 0 0 3px var(--panel); }
.bnode-icon .badge.ok { background: var(--ok); }
.bnode.hub .bnode-icon { width: 76px; height: 76px; border-radius: 24px; color: #fff; border: 0; background: linear-gradient(160deg, #5a76ff, #2442e0); box-shadow: 0 16px 40px -14px rgba(51, 85, 255, .6), inset 0 1px 0 rgba(255, 255, 255, .25); }
.bnode.todo .bnode-icon { border: 1.5px dashed var(--line-2); box-shadow: none; background: var(--panel-2); color: var(--text-3); }
.bnode.cur .bnode-icon { border: 1.5px solid var(--accent); box-shadow: 0 0 0 6px var(--accent-bg), var(--sh); color: var(--accent); }
.bnode-title { font-weight: 650; font-size: 15.5px; line-height: 1.3; }
.bnode-sub { font-size: 13px; color: var(--text-3); display: flex; align-items: center; gap: 6px; justify-content: center; flex-wrap: wrap; }
.bnode-stack { display: flex; justify-content: center; }
.bnode .m-only { display: none; }
.bnode-stack .os { width: 40px; height: 40px; border-radius: 12px; margin-left: -10px; box-shadow: 0 0 0 3px var(--panel); position: relative; }
.bnode-stack .os:first-child { margin-left: 0; }
.bnode-stack .os .dot { position: absolute; right: -2px; bottom: -2px; box-shadow: 0 0 0 2.5px var(--panel); }
.bnode-stack .os .dot.off { background: var(--panel); box-shadow: 0 0 0 2.5px var(--panel), inset 0 0 0 1.6px var(--off); }
.bline { position: relative; height: 2px; border-radius: 2px; background: var(--line-2); margin-top: -42px; }
.bline.todo { background: repeating-linear-gradient(90deg, var(--line-2) 0 6px, transparent 6px 12px); }
.bline.ok { background: linear-gradient(90deg, #8fd8b3, var(--ok)); }
.bline.ok::after { content: ""; position: absolute; top: -3px; left: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 4px rgba(14, 148, 84, .15); animation: travel 2.4s var(--ease) infinite; }
.bline.auth { background: linear-gradient(90deg, #a8b6ff, var(--accent)); }
.bline-label { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); white-space: nowrap; font-size: 12px; color: var(--text-3); }
@keyframes travel { from { left: 0; } to { left: calc(100% - 8px); } }
.bridge-note { position: relative; margin-top: 26px; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: var(--r); font-size: 14px; }
.bridge-note.err { background: var(--err-bg); color: #7a1f1f; border: 1px solid var(--err-line); }
.bridge-note.accent { background: var(--accent-bg); color: #1e2f8f; border: 1px solid var(--accent-line); }
.bridge-note .link { margin-left: auto; }

/* ---------- Step cards (onboarding) ---------- */
.journey { display: grid; grid-template-columns: 1.35fr 1fr 1fr; gap: 18px; margin-top: 22px; }
.jcard { position: relative; display: flex; flex-direction: column; gap: 14px; padding: 24px; border-radius: var(--r-lg); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--sh); }
.jcard.cur { border-color: var(--accent-line); box-shadow: 0 0 0 4px var(--accent-bg), var(--sh); }
.jcard.todo { background: var(--panel-2); box-shadow: none; }
.jcard.todo h3, .jcard.todo p { color: var(--text-3); }
.jcard .num { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 650; color: var(--accent); }
.jcard.todo .num { color: var(--text-3); }
.jcard .num b { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 12.5px; color: #fff; background: var(--accent); }
.jcard.todo .num b { background: var(--line-2); color: var(--text-2); }
.jcard.done .num b { background: var(--ok); }
.jcard h3 { margin: 0; font: 650 19px/1.3 var(--font-display); }
.jcard p { margin: 0; color: var(--text-2); font-size: 14.5px; }
.os-pick { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.os-opt { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 8px 14px; border-radius: 14px; border: 1.5px solid var(--line); background: var(--panel); cursor: pointer; font-size: 14px; font-weight: 600; transition: border-color .15s, box-shadow .15s, transform .15s; }
.os-opt:hover { border-color: var(--line-2); transform: translateY(-1px); }
.os-opt.on { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-bg); }
.os-opt small { font-weight: 500; color: var(--text-3); font-size: 12px; }
.bubble { align-self: flex-start; max-width: 100%; padding: 10px 14px; border-radius: 16px 16px 16px 4px; background: var(--sunken); font-size: 14px; color: var(--text-2); }
.bubble.me { align-self: flex-end; border-radius: 16px 16px 4px 16px; background: var(--accent); color: #fff; }

.trust { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.trust > div { display: flex; gap: 14px; align-items: flex-start; }
.trust .ic { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--panel); border: 1px solid var(--line); color: var(--text); flex: none; box-shadow: var(--sh-sm); }
.trust b { display: block; font-size: 15px; }
.trust span { font-size: 14px; color: var(--text-2); }

/* ---------- Device cards ---------- */
.dgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.dcard { display: flex; flex-direction: column; border-radius: var(--r-lg); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--sh); transition: box-shadow .2s, transform .2s, border-color .2s; overflow: hidden; }
.dcard:hover { box-shadow: var(--sh-lg); transform: translateY(-2px); }
.dcard-top { display: flex; align-items: flex-start; justify-content: space-between; padding: 20px 20px 0; }
.dcard-body { padding: 16px 20px 18px; flex: 1; }
.dcard-name { font: 650 17px/1.3 var(--font-display); letter-spacing: -.01em; }
.dcard-meta { margin-top: 4px; font-size: 13.5px; color: var(--text-3); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dcard-fix { margin-top: 12px; padding: 10px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5; }
.dcard-fix.err { background: var(--err-bg); color: #8a2323; }
.dcard-fix.off { background: var(--sunken); color: var(--text-2); }
.dcard-fix.ok { background: var(--ok-bg); color: #0b6b3d; display: flex; align-items: center; gap: 8px; }
.dcard-foot { display: flex; align-items: center; gap: 8px; padding: 12px 14px 12px 20px; border-top: 1px solid var(--line); background: var(--panel-2); font-size: 13px; color: var(--text-3); }
.dcard-foot .right { margin-left: auto; display: flex; gap: 4px; }
.dcard.err { border-color: var(--err-line); }
.dcard.revoked { box-shadow: none; background: var(--panel-2); }
.dcard.revoked .dcard-name { color: var(--text-3); }
.dcard.add { align-items: center; justify-content: center; gap: 12px; min-height: 196px; border: 1.5px dashed var(--line-2); background: transparent; box-shadow: none; color: var(--text-2); cursor: pointer; font-weight: 600; }
.dcard.add:hover { border-color: var(--accent); color: var(--accent); background: rgba(51, 85, 255, .03); transform: none; }
.dcard.add .plus { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: var(--panel); border: 1px solid var(--line); box-shadow: var(--sh-sm); }

.prompts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.prompt { display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; border-radius: var(--r-lg); background: var(--panel); border: 1px solid var(--line); box-shadow: var(--sh-sm); cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.prompt:hover { border-color: var(--accent-line); box-shadow: 0 0 0 4px var(--accent-bg); }
.prompt .t { font-size: 12.5px; color: var(--text-3); font-weight: 600; display: flex; align-items: center; gap: 6px; }
.prompt .q { font-size: 15px; color: var(--text); line-height: 1.5; }
.prompt .copy { margin-top: auto; font-size: 13px; color: var(--accent); font-weight: 600; display: flex; align-items: center; gap: 6px; }

.seg-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--line); margin-bottom: 22px; }
.seg-tabs button { position: relative; height: 42px; padding: 0 14px; border: 0; background: none; cursor: pointer; font-size: 14.5px; color: var(--text-2); display: flex; align-items: center; gap: 8px; }
.seg-tabs button.on { color: var(--text); font-weight: 600; }
.seg-tabs button.on::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; background: var(--text); border-radius: 2px; }
.seg-tabs .n { font-size: 12px; padding: 1px 7px; border-radius: 999px; background: var(--sunken); color: var(--text-2); font-weight: 600; }

/* ---------- Detail page ---------- */
.back { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; color: var(--text-2); margin-bottom: 18px; }
.back:hover { color: var(--text); }
.dhead { display: flex; align-items: center; gap: 20px; padding: 26px 28px; }
.dhead h1 { margin: 0; font: 680 28px/1.2 var(--font-display); letter-spacing: -.02em; display: flex; align-items: center; gap: 8px; }
.dhead .meta { margin-top: 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: var(--text-3); font-size: 14px; }
.dhead .right { margin-left: auto; display: flex; gap: 10px; }
.status-hero { display: flex; gap: 16px; align-items: flex-start; }
.status-hero .big { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; flex: none; }
.status-hero .big.ok { background: var(--ok-bg); color: var(--ok); }
.status-hero .big.err { background: var(--err-bg); color: var(--err); }
.status-hero .big.off, .status-hero .big.revoked { background: var(--sunken); color: var(--text-3); }
.status-hero .big.busy { background: var(--busy-bg); color: var(--busy); }
.status-hero h3 { margin: 2px 0 4px; font-size: 18px; }
.status-hero p { margin: 0; color: var(--text-2); }
.stepper { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin-top: 26px; }
.stepper .s { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; font-size: 13px; color: var(--text-3); text-align: center; }
.stepper .s::before { content: ""; position: absolute; top: 13px; right: 50%; width: 100%; height: 2px; background: var(--line); }
.stepper .s:first-child::before { display: none; }
.stepper .s.done::before, .stepper .s.cur::before { background: var(--ok); }
.stepper .s.fail::before { background: var(--err); }
.stepper .m { position: relative; z-index: 1; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--panel); border: 2px solid var(--line-2); color: var(--text-3); font-size: 12px; font-weight: 700; }
.stepper .s.done .m { background: var(--ok); border-color: var(--ok); color: #fff; }
.stepper .s.cur .m { background: var(--ok); border-color: var(--ok); color: #fff; box-shadow: 0 0 0 5px var(--ok-bg); }
.stepper .s.fail .m { background: var(--err); border-color: var(--err); color: #fff; box-shadow: 0 0 0 5px var(--err-bg); }
.stepper .s.done, .stepper .s.cur { color: var(--text-2); }
.stepper .s.cur { color: var(--text); font-weight: 600; }
.stepper .s.fail { color: var(--err); font-weight: 600; }
.fix-steps { margin: 20px 0 0; padding: 18px 20px; border-radius: var(--r); background: var(--panel-2); border: 1px solid var(--line); counter-reset: f; }
.fix-steps b { display: block; margin-bottom: 10px; font-size: 14.5px; }
.fix-steps li { list-style: none; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; padding: 6px 0; font-size: 14px; color: var(--text-2); }
.fix-steps li::before { counter-increment: f; content: counter(f); width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; color: var(--text-2); background: var(--panel); border: 1px solid var(--line-2); }
.props { margin: 0; display: flex; flex-direction: column; gap: 0; }
.props > div { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--line); font-size: 14px; }
.props > div:first-child { border-top: 0; padding-top: 0; }
.props dt { color: var(--text-3); }
.props dd { margin: 0; text-align: right; display: flex; align-items: center; gap: 6px; min-width: 0; }
.idbox { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 14px; border-radius: 10px; background: var(--sunken); font: 13px var(--mono); color: var(--text); }
.idbox span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.say { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--panel-2); cursor: pointer; font-size: 14.5px; }
.say:hover { border-color: var(--accent-line); }
.say .grow { flex: 1; }
.say .i { color: var(--accent); }

/* ---------- Callouts ---------- */
.callout { display: flex; gap: 12px; padding: 14px 16px; border-radius: var(--r); border: 1px solid var(--line); background: var(--panel-2); font-size: 14px; }
.callout .i { margin-top: 2px; color: var(--text-3); }
.callout b { display: block; margin-bottom: 2px; }
.callout p { margin: 0; color: var(--text-2); }
.callout.err { background: var(--err-bg); border-color: var(--err-line); } .callout.err .i { color: var(--err); } .callout.err b { color: #8a2323; }
.callout.busy { background: var(--busy-bg); border-color: var(--busy-line); } .callout.busy .i { color: var(--busy); }
.callout.ok { background: var(--ok-bg); border-color: var(--ok-line); } .callout.ok .i { color: var(--ok); }
.callout.accent { background: var(--accent-bg); border-color: var(--accent-line); } .callout.accent .i { color: var(--accent); }

/* ---------- Forms ---------- */
.field { display: flex; flex-direction: column; gap: 8px; }
.field label { font-size: 14px; font-weight: 600; }
.field .hint { font-size: 13px; color: var(--text-3); }
.input { width: 100%; height: 46px; padding: 0 14px; border-radius: 11px; border: 1px solid var(--line-2); background: var(--panel); color: var(--text); font: inherit; font-size: 15px; transition: border-color .15s, box-shadow .15s; }
.input::placeholder { color: var(--text-4); }
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-bg); }
.suggest { display: flex; gap: 8px; flex-wrap: wrap; }
.suggest button { height: 30px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--panel); font-size: 13px; color: var(--text-2); cursor: pointer; }
.suggest button:hover { border-color: var(--accent-line); color: var(--accent); }
.code-cells { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 600px; }
.code-cells .dash { width: 16px; height: 3px; border-radius: 3px; background: var(--line-2); flex: none; }
.cell { flex: 1 1 0; width: 0; min-width: 0; max-width: 64px; height: 76px; padding: 0; border-radius: 16px; text-align: center; font: 650 32px/1 var(--mono); color: var(--text); text-transform: uppercase; caret-color: var(--accent); background: var(--panel); border: 1.5px solid var(--line-2); box-shadow: var(--sh-sm); transition: border-color .15s, box-shadow .15s; }
.cell:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 5px var(--accent-bg); }
.cell.filled { border-color: #b9c0cc; }
.code-cells.error .cell { border-color: var(--err); box-shadow: 0 0 0 4px var(--err-bg); }
.code-cells.compact .cell { height: 60px; font-size: 26px; border-radius: 13px; max-width: 54px; }

/* Code block (dark on light) */
.code { border-radius: 14px; overflow: hidden; background: #0f1218; color: #e6e8ee; box-shadow: var(--sh); }
.code-bar { display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 8px 0 16px; background: #171b23; font-size: 13px; color: #9aa1b0; }
.code-bar .btn { margin-left: auto; height: 30px; font-size: 13px; color: #e6e8ee; background: rgba(255, 255, 255, .08); border: 0; }
.code-bar .btn:hover { background: rgba(255, 255, 255, .14); }
.code-body { padding: 14px 18px; font: 13.5px/1.8 var(--mono); }
.code-line { display: flex; gap: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.code-line .p { color: #5c6475; user-select: none; flex: none; }
.code-line .c { color: #6f7889; }
.code-line.out { color: #aab1bf; }
.code-line .hl { color: #0f1218; background: #ffc857; padding: 0 5px; border-radius: 4px; font-weight: 700; white-space: nowrap; }

/* Lifecycle checklist (light) */
.check { display: flex; flex-direction: column; gap: 4px; }
.check-item { display: flex; align-items: center; gap: 14px; padding: 12px 14px; border-radius: 12px; font-size: 15px; color: var(--text-3); }
.check-item .m { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; border: 2px solid var(--line-2); flex: none; background: var(--panel); }
.check-item.done { color: var(--text); }
.check-item.done .m { background: var(--ok); border-color: var(--ok); color: #fff; }
.check-item.cur { color: var(--text); background: var(--accent-bg); font-weight: 600; }
.check-item.cur .m { border-color: var(--accent); color: var(--accent); }
.check-item.cur .m .i { animation: spin 1s linear infinite; }
.check-item .t { flex: none; margin-left: auto; font: 12.5px var(--mono); color: var(--text-3); font-weight: 400; }
.check-item small { display: block; font-size: 13px; color: var(--text-3); font-weight: 400; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- Wizard (full screen) ---------- */
.wz { min-height: 100vh; display: flex; flex-direction: column; background: var(--panel); }
.wz-top { position: sticky; top: 0; z-index: 10; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; height: 68px; padding: 0 28px; background: rgba(255, 255, 255, .9); backdrop-filter: blur(12px); border-bottom: 1px solid var(--line); }
.wz-top .right { justify-self: end; }
.wz-steps { display: flex; align-items: center; gap: 8px; }
.wz-step { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-3); }
.wz-step b { width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 12.5px; border: 1.5px solid var(--line-2); color: var(--text-3); }
.wz-step.on { color: var(--text); font-weight: 600; } .wz-step.on b { background: var(--accent); border-color: var(--accent); color: #fff; }
.wz-step.done { color: var(--text-2); } .wz-step.done b { background: var(--ok); border-color: var(--ok); color: #fff; }
.wz-sep { width: 36px; height: 2px; border-radius: 2px; background: var(--line); }
.wz-sep.done { background: var(--ok); }
.wz-mstep { display: none; }
.wz-main { flex: 1; width: 100%; max-width: 760px; margin: 0 auto; padding: 56px 28px 40px; }
.wz-main .h1 { font-size: 32px; }
.wz-foot { position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; padding: 16px 28px; border-top: 1px solid var(--line); background: rgba(255, 255, 255, .92); backdrop-filter: blur(12px); }
.wz-foot-in { width: 100%; max-width: 760px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
.wz-foot .right { margin-left: auto; display: flex; gap: 10px; align-items: center; }
.big-os { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 32px; }
.big-os .os-opt { padding: 26px 12px 20px; gap: 12px; font-size: 16px; border-radius: 18px; }
.big-os .os-opt .os { width: 60px; height: 60px; border-radius: 18px; }
.reqs { margin-top: 28px; padding: 20px 22px; border-radius: var(--r-lg); background: var(--panel-2); border: 1px solid var(--line); }
.reqs b { font-size: 14.5px; }
.reqs ul { margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.reqs li { list-style: none; display: flex; align-items: center; gap: 10px; font-size: 14.5px; color: var(--text-2); }
.reqs li .i { color: var(--ok); }
.reqs code { font-family: var(--mono); font-size: 12.5px; background: var(--sunken); padding: 2px 7px; border-radius: 6px; color: var(--text); }
.substep { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 14px; margin-top: 28px; }
.substep .n { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; font-weight: 700; font-size: 14px; color: var(--accent); background: var(--accent-bg); }
.substep h3 { margin: 4px 0 6px; font-size: 17px; }
.substep p { margin: 0 0 14px; color: var(--text-2); }
.kbd { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--line-2); border-bottom-width: 2px; background: var(--panel); font: 600 12.5px var(--font); color: var(--text); }
.success-mark { width: 84px; height: 84px; margin: 0 auto 22px; border-radius: 50%; display: grid; place-items: center; color: #fff; background: var(--ok); box-shadow: 0 0 0 10px var(--ok-bg), 0 16px 40px -10px rgba(14, 148, 84, .5); animation: pop-in .5s var(--ease); }
@keyframes pop-in { from { transform: scale(.6); opacity: 0; } }
.next-card { display: flex; align-items: center; gap: 16px; padding: 20px 22px; border-radius: var(--r-lg); border: 1px solid var(--accent-line); background: var(--accent-bg); text-align: left; }
.next-card b { display: block; font-size: 16px; }
.next-card span { color: var(--text-2); font-size: 14px; }
.travel { display: flex; align-items: center; justify-content: center; gap: 0; margin: 8px 0 30px; }
.travel .os, .travel .hubi { width: 64px; height: 64px; border-radius: 20px; }
.travel .hubi { display: grid; place-items: center; color: #fff; background: linear-gradient(160deg, #5a76ff, #2442e0); box-shadow: 0 12px 30px -12px rgba(51, 85, 255, .6); }
.travel .path { position: relative; width: 160px; height: 2px; background: repeating-linear-gradient(90deg, var(--line-2) 0 6px, transparent 6px 12px); }
.travel .path::after { content: ""; position: absolute; top: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 5px var(--accent-bg); animation: travel 1.6s var(--ease) infinite; }

/* ---------- ChatGPT guide ---------- */
.gsteps { display: flex; flex-direction: column; gap: 18px; }
.gstep { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 24px; align-items: center; padding: 24px; }
.gstep .num { font-size: 13px; font-weight: 650; color: var(--accent); margin-bottom: 6px; }
.gstep h3 { margin: 0 0 8px; font: 650 18px/1.35 var(--font-display); }
.gstep p { margin: 0; color: var(--text-2); font-size: 14.5px; }
.gstep code { font-family: var(--mono); font-size: 12.5px; background: var(--sunken); padding: 2px 7px; border-radius: 6px; color: var(--text); }
.mock { border-radius: 14px; border: 1px solid var(--line); background: var(--panel-2); padding: 14px; font-size: 12.5px; box-shadow: inset 0 1px 0 #fff; }
.mock-bar { display: flex; gap: 5px; margin-bottom: 12px; } .mock-bar i { width: 8px; height: 8px; border-radius: 50%; background: var(--line-2); }
.mock-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); margin-top: 6px; color: var(--text-2); }
.mock-row.hl { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-bg); color: var(--text); font-weight: 600; }
.toggle { width: 30px; height: 18px; border-radius: 9px; background: var(--accent); position: relative; flex: none; }
.toggle::after { content: ""; position: absolute; right: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; }
.mock-field { margin-top: 8px; } .mock-field span { display: block; font-size: 11px; color: var(--text-3); margin-bottom: 3px; }
.mock-field div { padding: 7px 9px; border-radius: 7px; background: var(--panel); border: 1px solid var(--line); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mock-field.hl div { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-bg); font-family: var(--mono); font-size: 11.5px; }
.mock-btns { display: flex; gap: 6px; margin-top: 10px; } .mock-btns span { flex: 1; text-align: center; padding: 6px; border-radius: 7px; border: 1px solid var(--line); background: var(--panel); }
.mock-btns span.p { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
.mock-chat { display: flex; flex-direction: column; gap: 8px; }
.mock-chat .bubble { font-size: 12.5px; padding: 7px 11px; }
.mock-tool { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; border-radius: 999px; background: var(--panel); border: 1px solid var(--line); font-size: 11.5px; color: var(--text-2); }
.mock-caption { margin-top: 8px; font-size: 11.5px; color: var(--text-3); text-align: center; }
.conn { position: sticky; top: 88px; }
.conn .url { display: flex; align-items: center; gap: 10px; padding: 14px 10px 14px 16px; border-radius: 12px; background: var(--sunken); }
.conn .url span { flex: 1; min-width: 0; font: 14px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kv { display: flex; flex-direction: column; margin-top: 16px; }
.kv > div { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); font-size: 14px; }
.kv dt { color: var(--text-3); } .kv dd { margin: 0; font-weight: 600; text-align: right; }
.client { display: flex; align-items: center; gap: 16px; padding: 18px 22px; border-top: 1px solid var(--line); }
.client:first-child { border-top: 0; }
.client .grow { flex: 1; min-width: 0; }
.client .title { font-weight: 650; font-size: 15.5px; display: flex; align-items: center; gap: 8px; }
.client .meta { font-size: 13.5px; color: var(--text-3); display: flex; gap: 10px; flex-wrap: wrap; }
.auth-banner { display: flex; align-items: center; gap: 14px; padding: 16px 20px; border-radius: var(--r-lg); margin-bottom: 24px; }
.auth-banner.ok { background: var(--ok-bg); border: 1px solid var(--ok-line); }
.auth-banner.todo { background: var(--panel); border: 1.5px dashed var(--line-2); }
.auth-banner b { font-size: 15.5px; }
.auth-banner .right { margin-left: auto; }

/* ---------- Standalone (login, /device, consent) ---------- */
.solo { min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 48px 20px; background: radial-gradient(900px 420px at 50% -8%, #e4e9ff, transparent 70%), var(--bg); }
.solo-wrap { width: min(500px, 100%); display: flex; flex-direction: column; gap: 22px; }
.solo-brand { display: flex; justify-content: center; }
.solo-card { padding: 34px 34px 30px; border-radius: 24px; background: var(--panel); border: 1px solid var(--line); box-shadow: var(--sh-lg); }
.solo-card .h1 { font-size: 26px; }
.solo-foot { text-align: center; font-size: 13px; color: var(--text-3); display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; }
.mini-bridge { display: flex; align-items: center; justify-content: center; margin-bottom: 26px; }
.mini-bridge .t { width: 52px; height: 52px; border-radius: 16px; display: grid; place-items: center; background: var(--panel); border: 1px solid var(--line); box-shadow: var(--sh); color: var(--text); }
.mini-bridge .t.hub { color: #fff; border: 0; background: linear-gradient(160deg, #5a76ff, #2442e0); box-shadow: 0 10px 24px -10px rgba(51, 85, 255, .6); }
.mini-bridge .l { width: 44px; height: 2px; background: repeating-linear-gradient(90deg, var(--line-2) 0 5px, transparent 5px 10px); }
.mini-bridge .l.ok { background: linear-gradient(90deg, #a8b6ff, var(--accent)); }
.or { display: flex; align-items: center; gap: 14px; margin: 22px 0; font-size: 13px; color: var(--text-4); }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }
details.owner { border-radius: 14px; border: 1px solid var(--line); background: var(--panel-2); }
details.owner summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 14px 16px; cursor: pointer; font-size: 14.5px; color: var(--text-2); font-weight: 550; }
details.owner summary::-webkit-details-marker { display: none; }
details.owner summary .i:last-child { margin-left: auto; transition: transform .2s; }
details.owner[open] summary .i:last-child { transform: rotate(180deg); }
details.owner .inner { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.fine { font-size: 13px; color: var(--text-3); line-height: 1.6; }
.whoami { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); font-size: 14px; }
.whoami .avatar { width: 30px; height: 30px; font-size: 13px; }
.whoami .grow { flex: 1; }
.scope { margin: 22px 0 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.scope li { list-style: none; display: flex; gap: 14px; align-items: flex-start; font-size: 15px; }
.scope .ic { width: 36px; height: 36px; border-radius: 11px; display: grid; place-items: center; background: var(--sunken); color: var(--text); flex: none; }
.scope small { display: block; color: var(--text-3); font-size: 13px; }
.detail-box { margin-top: 20px; padding: 14px 16px; border-radius: 12px; background: var(--panel-2); border: 1px solid var(--line); display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 8px 12px; font-size: 13px; }
.detail-box dt { color: var(--text-3); }
.detail-box dd { margin: 0; font: 12.5px var(--mono); overflow-wrap: anywhere; }
.detail-box dd.hl { color: var(--accent); font-weight: 600; }

/* ---------- Overlays ---------- */
.scrim { position: fixed; inset: 0; z-index: 60; background: rgba(14, 17, 22, .35); backdrop-filter: blur(3px); animation: fade .2s var(--ease); }
.dialog { position: fixed; z-index: 61; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(480px, calc(100vw - 32px)); border-radius: 22px; background: var(--panel); box-shadow: 0 40px 100px -20px rgba(14, 17, 22, .35); animation: pop .22s var(--ease); }
.dialog-body { padding: 28px 28px 20px; }
.dialog h3 { margin: 16px 0 8px; font-size: 19px; }
.dialog p { margin: 0; color: var(--text-2); }
.dialog ul { margin: 12px 0 0; padding-left: 20px; color: var(--text-2); font-size: 14px; }
.dialog-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 16px 28px 24px; }
.danger-mark { width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; background: var(--err-bg); color: var(--err); }
@keyframes fade { from { opacity: 0; } }
@keyframes pop { from { opacity: 0; transform: translate(-50%, -47%) scale(.98); } }
.toast-host { position: fixed; z-index: 80; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-radius: 12px; background: var(--text); color: #fff; font-size: 14px; box-shadow: 0 16px 40px -10px rgba(14, 17, 22, .4); transform: translateY(8px); opacity: 0; transition: transform .25s var(--ease), opacity .25s var(--ease); }
.toast.in { transform: none; opacity: 1; }
.toast-ok .i { color: #5ee2a0; } .toast-err .i { color: #ff8a8a; } .toast-info .i { color: #a9b8ff; }

/* Prototype panel */

/* ---------- Responsive ---------- */
.mtab, .mfab { display: none; }
@media (max-width: 1080px) {
  .dgrid, .prompts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .journey { grid-template-columns: 1fr 1fr; }
  .journey .jcard:first-child { grid-column: 1 / -1; }
  .cols { grid-template-columns: minmax(0, 1fr); }
  .conn { position: static; }
  .gstep { grid-template-columns: minmax(0, 1fr) 260px; }
}
@media (max-width: 760px) {
  body { font-size: 15px; }
  .nav-in { height: 56px; padding: 0 16px; gap: 12px; }
  .tabs, .nav-right .btn { display: none; }
  .wrap { padding: 22px 16px 104px; }
  .h1 { font-size: 26px; }
  .lead { font-size: 15px; }
  .page-head { flex-wrap: wrap; margin-bottom: 20px; }
  .page-head .actions { display: none; }
  .bridge { padding: 22px 18px; }
  .bridge-row { grid-template-columns: minmax(0, 1fr); gap: 0; justify-items: center; }
  .bline { width: 2px; height: 34px; margin: 10px 0; }
  .bline.ok { background: linear-gradient(180deg, #8fd8b3, var(--ok)); }
  .bline.auth { background: linear-gradient(180deg, #a8b6ff, var(--accent)); }
  .bline.todo { background: repeating-linear-gradient(180deg, var(--line-2) 0 6px, transparent 6px 12px); }
  .bline.ok::after { left: -3px; animation: travel-v 2s var(--ease) infinite; }
  .bline-label { left: 14px; top: 50%; transform: translateY(-50%); }
  .bnode { flex-direction: row; text-align: left; width: 100%; max-width: 340px; gap: 14px; }
  .bnode-icon, .bnode.hub .bnode-icon { width: 52px; height: 52px; border-radius: 16px; }
  .bnode-sub { justify-content: flex-start; }
  .bnode-stack { display: none; }
  .bnode .m-only { display: grid; }
  .bridge-note { flex-wrap: wrap; }
  .bridge-note span { flex: 1 1 220px; }
  .bridge-note .link { margin-left: 27px; }
  .journey, .dgrid, .prompts, .trust { grid-template-columns: minmax(0, 1fr); }
  .journey .jcard:first-child { grid-column: auto; }
  .dhead { flex-wrap: wrap; padding: 20px; gap: 14px; }
  .dhead h1 { font-size: 22px; }
  .dhead .right { width: 100%; margin-left: 0; }
  .dhead .right .btn { flex: 1; }
  .stepper .s { font-size: 11px; }
  .gstep { grid-template-columns: minmax(0, 1fr); padding: 20px; }
  .client { flex-wrap: wrap; padding: 16px; }
  .wz-top { grid-template-columns: auto 1fr auto; padding: 0 16px; height: 58px; }
  .wz-top .brand > span:not(.logo-tile) { display: none; }
  .wz-steps { display: none; }
  .wz-mstep { display: block; justify-self: center; font-size: 14px; font-weight: 600; color: var(--text-2); }
  .wz-main { padding: 28px 18px 24px; }
  .wz-main .h1 { font-size: 25px; }
  .big-os { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  .big-os .os-opt { padding: 18px 6px 14px; font-size: 14px; }
  .big-os .os-opt .os { width: 46px; height: 46px; border-radius: 14px; }
  .wz-foot { padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); }
  .wz-foot .right { flex: 1; } .wz-foot .right .btn { flex: 1; }
  .cell { height: 58px; font-size: 24px; border-radius: 12px; }
  .code-cells { gap: 6px; }
  .solo { padding: 24px 14px; }
  .solo-card { padding: 26px 20px 22px; border-radius: 20px; }
  .travel .path { width: 90px; }
  .mtab { display: grid; grid-template-columns: repeat(4, 1fr); position: fixed; z-index: 30; left: 0; right: 0; bottom: 0; height: 66px; padding: 6px 6px calc(6px + env(safe-area-inset-bottom)); background: rgba(255, 255, 255, .94); backdrop-filter: blur(16px); border-top: 1px solid var(--line); }
  .mtab a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; font-size: 11px; color: var(--text-3); font-weight: 550; }
  .mtab a.on { color: var(--accent); }
  .mfab { display: inline-flex; position: fixed; z-index: 31; right: 16px; bottom: 80px; height: 48px; padding: 0 18px; border-radius: 24px; box-shadow: 0 12px 30px -8px rgba(51, 85, 255, .55); }
}
@keyframes travel-v { from { top: 0; } to { top: calc(100% - 8px); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }

.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lang-switch{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:8px;font-size:13px;color:var(--text-3);margin:12px 0 24px}
.lang-switch a:hover{color:var(--accent)}
.lang-switch form{margin:0}.lang-switch button{border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:4px 8px}
/* Secondary labels within cobalt buttons must keep AA text contrast. */
.btn-primary .muted{color:#fff}
/* Account-owned device action menu. Appended after baseline prototype CSS. */
.dcard { overflow: visible; position: relative; }
.dcard-top .chip { margin-left: auto; }
.dcard-menu { position: relative; margin-left: 8px; z-index: 3; }
.dcard-menu summary { display: flex; align-items: center; justify-content: center; cursor: pointer; list-style: none; }
.dcard-menu summary::-webkit-details-marker { display: none; }
.dcard-menu-pop { position: absolute; top: 34px; right: 0; width: 170px; display: grid; gap: 2px; padding: 6px; background: var(--panel); border: 1px solid var(--line-2); border-radius: 12px; box-shadow: var(--sh-lg); }
.dcard-menu-pop a { display: block; padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--text-2); }
.dcard-menu-pop a:hover, .dcard-menu-pop a:focus-visible { background: var(--sunken); color: var(--text); }
.dcard-menu-pop a.danger { color: var(--err); }
`;
