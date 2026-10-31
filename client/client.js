// Aurabot · 网页半边：侧栏「自动化任务」下面的「Aurabot」入口 + 整页面板（顶部标签切换功能）。
// 只读写宿主半边的 /aurabot/api/* 接口，不直接碰会话和 QQ。
// 视觉：沿用 DSH 的主题变量（--dsw-alias-*），浅色 / 深色自动跟随；点缀用大肥鱼的深蓝、海蓝、白。

window.__ModuleLoader__.load({
  id: 'dsh-aurabot-qq',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect, useRef, useCallback, useMemo, Fragment } = React
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'aurabot'
    const API = '/aurabot/api'

    // ---------------- 小工具 ----------------
    const get = (p) => fetch(API + p, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))
    const post = (p, body) =>
      fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
        .then((r) => r.json())
        .catch((e) => ({ ok: false, message: '连不上插件：' + e.message }))
    const clone = (o) => JSON.parse(JSON.stringify(o))
    const setPath = (obj, path, value) => {
      const next = clone(obj)
      let cur = next
      const ks = path.split('.')
      for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] = cur[ks[i]] || {}
      cur[ks[ks.length - 1]] = value
      return next
    }
    const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
    const pct = (v) => Math.round((Number(v) || 0) * 100)
    const cx = (...a) => a.filter(Boolean).join(' ')
    const timeAgo = (t) => {
      if (!t) return '—'
      const s = Math.round((Date.now() - t) / 1000)
      if (s < 60) return '刚刚'
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
      return new Date(t).toLocaleDateString()
    }

    // ---------------- 样式（只注入一次） ----------------
    const CSS = `
.ab-root{--ab-deep:#1d3b6f;--ab-sea:#3d7fd6;--ab-sky:#7fb3ee;--ab-foam:rgba(61,127,214,.10);--ab-foam-2:rgba(61,127,214,.18);
  --ab-text:var(--dsw-alias-label-primary,#1f2328);--ab-sub:var(--dsw-alias-label-secondary,#57606a);--ab-dim:var(--dsw-alias-label-tertiary,#8b949e);
  --ab-bg:var(--dsw-alias-bg-base,#fff);--ab-card:var(--dsw-alias-bg-layer-1,#fff);--ab-card-2:var(--dsw-alias-bg-layer-2,#f6f8fa);
  --ab-line:var(--dsw-alias-border-l1,rgba(0,0,0,.08));--ab-line-2:var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  --ab-ok:var(--dsw-alias-state-success-primary,#1a7f37);--ab-warn:var(--dsw-alias-state-warn-primary,#bf8700);--ab-err:var(--dsw-alias-state-error-primary,#cf222e);
  --ab-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.04));
  height:100%;overflow:auto;background:var(--ab-bg);color:var(--ab-text);font-size:13px;line-height:1.6;
  padding:var(--dsh-frame-top-clearance,24px) 0 40px;box-sizing:border-box;font-family:var(--dsh-font-family-ui,inherit)}
body[data-ds-dark-theme] .ab-root,.ab-root.ab-dark{--ab-deep:#9cc4f5;--ab-sea:#6aa6ef;--ab-sky:#a9cdf7;--ab-foam:rgba(106,166,239,.12);--ab-foam-2:rgba(106,166,239,.22)}
.ab-wrap{max-width:1040px;margin:0 auto;padding:0 28px}
.ab-hero{display:flex;align-items:center;gap:18px;padding:18px 20px;border-radius:16px;border:1px solid var(--ab-line);
  background:linear-gradient(120deg,var(--ab-foam-2),var(--ab-foam) 45%,transparent 80%),var(--ab-card);position:relative;overflow:hidden}
.ab-hero:after{content:"";position:absolute;right:-40px;bottom:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,var(--ab-foam-2),transparent 70%);pointer-events:none}
.ab-avatar{width:72px;height:72px;border-radius:50%;object-fit:cover;object-position:50% 18%;background:#fff;border:3px solid var(--ab-card);box-shadow:0 0 0 2px var(--ab-sea);flex:none}
.ab-hero h1{margin:0;font-size:20px;font-weight:650;letter-spacing:.5px;color:var(--ab-text)}
.ab-hero .ab-sub{color:var(--ab-sub);margin-top:2px}
.ab-hero-main{flex:1;min-width:0;position:relative;z-index:1}
.ab-hero-side{display:flex;flex-direction:column;gap:8px;align-items:flex-end;position:relative;z-index:1}
.ab-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.ab-pill{display:inline-flex;align-items:center;gap:6px;padding:2px 10px;border-radius:999px;font-size:12px;background:var(--ab-card-2);border:1px solid var(--ab-line);color:var(--ab-sub)}
.ab-dot{width:7px;height:7px;border-radius:50%;background:var(--ab-dim)}
.ab-dot.ok{background:var(--ab-ok)}.ab-dot.warn{background:var(--ab-warn)}.ab-dot.err{background:var(--ab-err)}
.ab-tabs{display:flex;flex-wrap:wrap;gap:2px;margin:18px 0 16px;padding:4px;border-radius:12px;background:var(--ab-card-2);border:1px solid var(--ab-line);position:sticky;top:0;z-index:5}
.ab-tabs::-webkit-scrollbar{height:6px}.ab-tabs::-webkit-scrollbar-thumb{background:var(--ab-line);border-radius:3px}.ab-tabs:hover::-webkit-scrollbar-thumb{background:var(--ab-dim)}
.ab-tab{flex:none;border:0;background:transparent;color:var(--ab-sub);padding:6px 12px;border-radius:8px;font-size:13px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.ab-tab:hover{background:var(--ab-hover);color:var(--ab-text)}
.ab-tab.on{background:var(--ab-card);color:var(--ab-deep);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px var(--ab-line)}
.ab-tab .ab-dot{width:6px;height:6px}
.ab-grid{display:grid;gap:12px}
.ab-g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.ab-g4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.ab-card{background:var(--ab-card);border:1px solid var(--ab-line);border-radius:14px;padding:16px 18px}
.ab-card h3{margin:0 0 4px;font-size:14px;font-weight:620;display:flex;align-items:center;gap:8px}
.ab-card .ab-desc{color:var(--ab-sub);font-size:12.5px;margin:0 0 12px}
.ab-stat{padding:14px 16px}
.ab-stat .n{font-size:24px;font-weight:650;color:var(--ab-deep);font-variant-numeric:tabular-nums}
.ab-stat .l{color:var(--ab-sub);font-size:12px}
.ab-row{display:flex;align-items:flex-start;gap:16px;padding:10px 0;border-top:1px solid var(--ab-line)}
.ab-row:first-of-type{border-top:0}
.ab-row .ab-label{flex:0 0 180px;padding-top:5px}
.ab-row .ab-label b{display:block;font-weight:560}
.ab-row .ab-label small{display:block;color:var(--ab-dim);font-size:11.5px;line-height:1.45;margin-top:2px}
.ab-row .ab-ctl{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
@media (max-width:640px){.ab-row{flex-direction:column;gap:6px}.ab-row .ab-label{flex:none}.ab-wrap{padding:0 14px}.ab-hero{flex-wrap:wrap}.ab-hero-side{align-items:flex-start}}
.ab-input,.ab-select,.ab-textarea{border:1px solid var(--ab-line-2);border-radius:8px;padding:6px 10px;background:var(--ab-card);color:var(--ab-text);font:inherit;outline:none;min-width:0;box-sizing:border-box}
.ab-input:focus,.ab-select:focus,.ab-textarea:focus{border-color:var(--ab-sea);box-shadow:0 0 0 3px var(--ab-foam-2)}
.ab-input{width:240px;max-width:100%}.ab-input.sm{width:90px}.ab-input.wide{width:100%}
.ab-textarea{width:100%;min-height:90px;resize:vertical;line-height:1.55;font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:12.5px}
.ab-btn{border:1px solid var(--ab-line-2);background:var(--ab-card);color:var(--ab-text);padding:6px 14px;border-radius:8px;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.ab-btn:hover{background:var(--ab-hover)}
.ab-btn:disabled{opacity:.5;cursor:default}
.ab-btn.primary{background:var(--ab-sea);border-color:var(--ab-sea);color:#fff}
.ab-btn.primary:hover{filter:brightness(1.07)}
.ab-btn.danger{color:var(--ab-err)}
.ab-btn.ghost{border-color:transparent;background:transparent;color:var(--ab-sub)}
.ab-btn.sm{padding:3px 10px;font-size:12px}
.ab-switch{position:relative;width:38px;height:22px;border-radius:999px;background:var(--ab-line-2);border:0;cursor:pointer;flex:none;transition:background .15s}
.ab-switch:after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}
.ab-switch.on{background:var(--ab-sea)}.ab-switch.on:after{left:19px}
.ab-switch-row{display:flex;align-items:center;gap:10px}
.ab-seg{display:inline-flex;border:1px solid var(--ab-line-2);border-radius:9px;overflow:hidden}
.ab-seg button{border:0;background:transparent;padding:6px 14px;font:inherit;color:var(--ab-sub);cursor:pointer;border-left:1px solid var(--ab-line)}
.ab-seg button:first-child{border-left:0}
.ab-seg button.on{background:var(--ab-foam-2);color:var(--ab-deep);font-weight:600}
.ab-seg.off{opacity:.45}
.ab-seg.off button{cursor:not-allowed}
.ab-note{padding:10px 12px;border-radius:10px;background:var(--ab-foam);color:var(--ab-text);font-size:12.5px;border:1px solid var(--ab-foam-2)}
.ab-note.warn{background:rgba(191,135,0,.08);border-color:rgba(191,135,0,.25)}
.ab-note.err{background:rgba(207,34,46,.07);border-color:rgba(207,34,46,.25)}
.ab-steps{counter-reset:s;display:flex;flex-direction:column;gap:10px}
.ab-step{display:flex;gap:12px;align-items:flex-start}
.ab-step:before{counter-increment:s;content:counter(s);flex:none;width:22px;height:22px;border-radius:50%;background:var(--ab-foam-2);color:var(--ab-deep);font-weight:650;display:flex;align-items:center;justify-content:center;font-size:12px}
.ab-step.done:before{content:"✓";background:var(--ab-ok);color:#fff}
.ab-step > div{flex:1;min-width:0}
.ab-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:12.5px}
.ab-kv span:nth-child(odd){color:var(--ab-sub)}
.ab-stickers{display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px}
.ab-sticker{border:1px solid var(--ab-line);border-radius:12px;padding:8px;background:var(--ab-card);display:flex;flex-direction:column;gap:6px;position:relative}
.ab-sticker img{width:100%;aspect-ratio:1;object-fit:contain;border-radius:8px;background:var(--ab-card-2)}
.ab-sticker .nm{font-size:12px;border:0;background:transparent;color:var(--ab-text);text-align:center;width:100%;outline:none;padding:2px;border-radius:6px}
.ab-sticker .nm:focus{background:var(--ab-card-2)}
.ab-sticker .tg{font-size:11px;color:var(--ab-dim);text-align:center;min-height:16px}
.ab-sticker .x{position:absolute;top:4px;right:4px;opacity:0;transition:opacity .15s}
.ab-sticker:hover .x{opacity:1}
.ab-list{display:flex;flex-direction:column}
.ab-li{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--ab-line)}
.ab-li:first-child{border-top:0}
.ab-li .meta{color:var(--ab-dim);font-size:11.5px;white-space:nowrap}
.ab-li .body{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.ab-logs{font-family:var(--dsh-font-family-code,ui-monospace,monospace);font-size:12px;max-height:520px;overflow:auto;border-radius:10px;background:var(--ab-card-2);padding:8px 0}
.ab-log{display:flex;gap:10px;padding:2px 12px;align-items:baseline}
.ab-log:hover{background:var(--ab-hover)}
.ab-log .t{color:var(--ab-dim);flex:none}
.ab-log .a{flex:none;color:var(--ab-sea);min-width:62px}
.ab-log .m{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.ab-log.warn .m{color:var(--ab-warn)}.ab-log.error .m{color:var(--ab-err)}.ab-log.debug .m{color:var(--ab-dim)}
.ab-pre{white-space:pre-wrap;word-break:break-word;background:var(--ab-card-2);border:1px solid var(--ab-line);border-radius:10px;padding:10px 12px;font-size:12px;max-height:420px;overflow:auto;margin:0}
.ab-persona{display:grid;grid-template-columns:300px 1fr;gap:12px}
.ab-brow{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:6px 0}.ab-brow>span{color:var(--ab-sub);white-space:nowrap}
.ab-span{grid-column:1/-1}
.ab-imgref{display:flex;flex-direction:column;align-items:center;gap:4px}.ab-imgref img{width:88px;height:88px;object-fit:cover;border-radius:8px;border:1px solid var(--ab-line)}
.ab-thumb{width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid var(--ab-line);background:var(--ab-card-2);flex:none}.ab-thumb.big{width:240px;height:auto;max-height:320px;object-fit:contain}
.ab-mask{margin:10px 0;padding:10px;border:1px dashed var(--ab-line-2);border-radius:10px}.ab-mask-stage{position:relative;display:inline-block;max-width:100%;margin-top:6px}.ab-mask-stage img{display:block;max-width:100%;max-height:420px}.ab-mask-stage canvas{position:absolute;inset:0;width:100%;height:100%;opacity:.55;cursor:crosshair;touch-action:none}
.ab-psec{border-top:1px solid var(--ab-line);margin-top:14px;padding-top:10px}.ab-psec h4{margin:0 0 6px;font-size:13px;font-weight:600}
@media (max-width:760px){.ab-persona{grid-template-columns:1fr}}
.ab-plist{display:flex;flex-direction:column;gap:6px}
.ab-pitem{text-align:left;border:1px solid var(--ab-line);background:var(--ab-card);border-radius:10px;padding:10px 12px;cursor:pointer;color:var(--ab-text);font:inherit}
.ab-pitem:hover{border-color:var(--ab-line-2)}
.ab-pitem.on{border-color:var(--ab-sea);box-shadow:0 0 0 3px var(--ab-foam)}
.ab-pitem .nm{font-weight:600;display:flex;align-items:center;gap:6px}
.ab-pitem .tg{color:var(--ab-dim);font-size:11.5px;margin-top:2px}
.ab-badge{font-size:10.5px;padding:0 6px;border-radius:999px;background:var(--ab-sea);color:#fff;font-weight:500}
.ab-mood{height:10px;border-radius:999px;background:var(--ab-card-2);overflow:hidden;border:1px solid var(--ab-line)}
.ab-mood > i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--ab-sky),var(--ab-sea))}
.ab-savebar{position:sticky;bottom:12px;margin-top:16px;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:var(--ab-card);border:1px solid var(--ab-sea);box-shadow:0 6px 24px rgba(0,0,0,.12);z-index:6}
.ab-savebar .msg{flex:1;color:var(--ab-deep);font-weight:560}
.ab-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:9px 16px;border-radius:10px;background:var(--dsw-alias-toast-bg,#1f2328);color:var(--dsw-alias-toast-label,#fff);font-size:13px;z-index:50;box-shadow:0 6px 24px rgba(0,0,0,.2);max-width:80vw}
.ab-empty{padding:28px 12px;text-align:center;color:var(--ab-dim)}
.ab-empty .big{font-size:28px;margin-bottom:4px}
.ab-table{width:100%;border-collapse:collapse;font-size:12.5px}
.ab-table th{text-align:left;color:var(--ab-sub);font-weight:500;padding:6px 8px;border-bottom:1px solid var(--ab-line)}
.ab-table td{padding:6px 8px;border-bottom:1px solid var(--ab-line)}
.ab-token-ranges{display:flex;gap:6px;flex-wrap:wrap}
.ab-token-ranges button[aria-pressed=true]{background:var(--ab-foam-2);border-color:var(--ab-sea);color:var(--ab-deep);font-weight:600}
.ab-token-table-wrap,.ab-token-chart-scroll{max-width:100%;overflow-x:auto}
.ab-token-table{min-width:690px;font-variant-numeric:tabular-nums}
.ab-token-table th[scope=row]{text-align:left;overflow-wrap:anywhere;min-width:130px}
.ab-token-chart-scroll{border:1px solid var(--ab-line);border-radius:10px;background:var(--ab-card-2)}
.ab-token-chart-scroll svg{display:block;max-width:none}
.ab-token-chart-scroll svg:focus-visible{outline:2px solid var(--ab-sea);outline-offset:-3px}
.ab-token-chart-detail{min-height:1.6em;margin:8px 0 0;font-variant-numeric:tabular-nums}
.ab-token-stat .n{font-size:clamp(18px,2.8vw,28px);overflow-wrap:anywhere}
.ab-token-stat-status{margin-top:4px;color:var(--ab-sub);font-size:12px}
.ab-token-filters .ab-input[type=date]{width:165px}
.ab-flex{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ab-spacer{flex:1}
.ab-muted{color:var(--ab-sub)}
.ab-small{font-size:12px}
.ab-section-title{font-size:12px;font-weight:600;color:var(--ab-dim);letter-spacing:.06em;margin:18px 2px 8px}
.ab-sel{position:relative;display:inline-block;min-width:200px;max-width:100%}
.ab-sel-btn{width:100%;display:flex;align-items:center;gap:8px;border:1px solid var(--ab-line-2);border-radius:9px;padding:6px 10px;background:var(--ab-card);color:var(--ab-text);font:inherit;cursor:pointer;text-align:left}
.ab-sel-btn:hover{border-color:var(--ab-sky)}
.ab-sel-btn:focus-visible,.ab-sel.open .ab-sel-btn{outline:none;border-color:var(--ab-sea);box-shadow:0 0 0 3px var(--ab-foam-2)}
.ab-sel-btn .v{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ab-sel-btn .chev{flex:none;color:var(--ab-dim);transition:transform .15s}
.ab-sel.open .chev{transform:rotate(180deg)}
.ab-sel-pop{position:absolute;z-index:40;top:calc(100% + 6px);left:0;min-width:100%;max-height:300px;overflow:auto;padding:5px;border-radius:12px;background:var(--ab-card);border:1px solid var(--ab-line-2);box-shadow:0 12px 32px rgba(0,0,0,.16);animation:abPop .12s ease-out}
@keyframes abPop{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.ab-sel-opt{display:flex;align-items:flex-start;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;color:var(--ab-text);white-space:nowrap}
.ab-sel-opt .ck{width:14px;flex:none;color:var(--ab-sea);font-weight:700}
.ab-sel-opt .tx{flex:1;min-width:0}
.ab-sel-opt .ds{display:block;font-size:11.5px;color:var(--ab-dim);margin-top:1px;white-space:normal}
.ab-sel-opt.act{background:var(--ab-hover)}
.ab-sel-opt.on{background:var(--ab-foam);color:var(--ab-deep);font-weight:560}
.ab-sel-group{font-size:11px;color:var(--ab-dim);padding:6px 10px 2px;letter-spacing:.04em}
.ab-choices{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px;width:100%}
.ab-choice{border:1px solid var(--ab-line-2);border-radius:12px;padding:10px 12px;background:var(--ab-card);cursor:pointer;text-align:left;font:inherit;color:var(--ab-text);transition:border-color .12s,box-shadow .12s}
.ab-choice:hover{border-color:var(--ab-sky)}
.ab-choice.on{border-color:var(--ab-sea);box-shadow:0 0 0 3px var(--ab-foam);background:linear-gradient(var(--ab-foam),var(--ab-foam)),var(--ab-card)}
.ab-choice b{display:flex;align-items:center;gap:6px;font-weight:600}
.ab-choice small{display:block;color:var(--ab-dim);font-size:11.5px;margin-top:3px;line-height:1.45}
.ab-tab .dirty{width:6px;height:6px;border-radius:50%;background:var(--ab-warn)}
.ab-toast.ok{background:var(--ab-ok);color:#fff}.ab-toast.err{background:var(--ab-err);color:#fff}
.ab-kbd{font-family:var(--dsh-font-family-code,monospace);font-size:11px;padding:0 5px;border:1px solid var(--ab-line-2);border-radius:5px;color:var(--ab-dim)}
.ab-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:abSpin .7s linear infinite;vertical-align:-2px}
@keyframes abSpin{to{transform:rotate(360deg)}}
.ab-drop{border:2px dashed var(--ab-line-2);border-radius:12px;padding:22px 16px;text-align:center;color:var(--ab-sub);cursor:pointer;transition:border-color .15s,background .15s}
.ab-drop:hover,.ab-drop:focus-visible{border-color:var(--ab-sky);outline:none}
.ab-drop.over{border-color:var(--ab-sea);background:var(--ab-foam);color:var(--ab-deep)}
.ab-avatar-btn{position:relative;padding:0;border:0;background:none;cursor:pointer;border-radius:50%;flex:none}
.ab-avatar-btn .ab-avatar-tip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(15,40,80,.45);color:#fff;font-size:12px;opacity:0;transition:opacity .15s}
.ab-avatar-btn:hover .ab-avatar-tip,.ab-avatar-btn:focus-visible .ab-avatar-tip{opacity:1}
.ab-wiz-bar{display:flex;gap:6px;margin-top:12px}
.ab-wiz-bar .seg{flex:1;border:0;background:transparent;padding:0;cursor:default;text-align:left;font:inherit;color:var(--ab-dim)}
.ab-wiz-bar .seg:before{content:"";display:block;height:4px;border-radius:999px;background:var(--ab-line-2);margin-bottom:6px}
.ab-wiz-bar .seg.done{cursor:pointer;color:var(--ab-sub)}.ab-wiz-bar .seg.done:before{background:var(--ab-sky)}
.ab-wiz-bar .seg.on{color:var(--ab-deep);font-weight:600}.ab-wiz-bar .seg.on:before{background:var(--ab-sea)}
.ab-wiz-bar .seg span{font-size:11.5px}
@media (max-width:640px){.ab-wiz-bar .seg span{display:none}}
.ab-range{display:flex;align-items:center;gap:10px;min-width:240px}
.ab-range input[type=range]{flex:1;accent-color:var(--ab-sea)}
.ab-range .val{min-width:48px;text-align:right;font-variant-numeric:tabular-nums;color:var(--ab-deep);font-weight:600}
/* ---------- 美化 ---------- */
.ab-root{--ab-shadow:0 1px 2px rgba(15,40,80,.04),0 4px 16px rgba(15,40,80,.05);--ab-radius:16px}
body[data-ds-dark-theme] .ab-root,.ab-root.ab-dark{--ab-shadow:0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.25)}
.ab-hero{padding:20px 22px;border-radius:20px;box-shadow:var(--ab-shadow);background:
  radial-gradient(120% 140% at 0% 0%,var(--ab-foam-2),transparent 55%),
  linear-gradient(120deg,var(--ab-foam),transparent 70%),var(--ab-card)}
.ab-hero:before{content:"";position:absolute;left:0;right:0;bottom:-1px;height:46px;pointer-events:none;opacity:.55;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1200 60' preserveAspectRatio='none'%3E%3Cpath d='M0 30c150-26 300 26 450 0s300-26 450 0 225 18 300 8v22H0z' fill='%233d7fd6' fill-opacity='.10'/%3E%3Cpath d='M0 42c180-20 330 18 520 2s340-16 480 2 150 8 200 4v10H0z' fill='%233d7fd6' fill-opacity='.08'/%3E%3C/svg%3E") bottom/100% 100% no-repeat}
.ab-hero h1{font-size:22px}
.ab-pill{background:var(--ab-card);box-shadow:0 1px 1px rgba(15,40,80,.04)}
.ab-grid{gap:14px}
.ab-card{border-radius:var(--ab-radius);padding:18px 20px;box-shadow:var(--ab-shadow);transition:box-shadow .15s}
.ab-card h3{font-size:15px;font-weight:650;color:var(--ab-text)}
.ab-card h3:before{content:"";width:4px;height:15px;border-radius:2px;background:linear-gradient(var(--ab-sky),var(--ab-sea));flex:none}
.ab-card .ab-desc{margin:4px 0 14px;line-height:1.65}
.ab-stat{position:relative;overflow:hidden;padding:16px 18px;background:linear-gradient(150deg,var(--ab-foam),transparent 60%),var(--ab-card)}
.ab-stat .ic{position:absolute;right:14px;top:12px;font-size:22px;opacity:.9}
.ab-stat .n{font-size:28px;line-height:1.2}
.ab-row{padding:12px 0;gap:20px}
.ab-row .ab-label{flex:0 0 200px}
.ab-row .ab-label small{max-width:200px}
.ab-range{max-width:440px}
.ab-range .val{min-width:0;padding:1px 9px;border-radius:999px;background:var(--ab-foam);font-size:12px;white-space:nowrap}
.ab-range input[type=range]{height:4px}
.ab-input,.ab-select,.ab-textarea,.ab-sel-btn{border-radius:10px;transition:border-color .12s,box-shadow .12s}
.ab-input:hover,.ab-textarea:hover{border-color:var(--ab-sky)}
.ab-textarea{font-family:inherit;font-size:13px}
.ab-btn{border-radius:10px;transition:background .12s,border-color .12s,box-shadow .12s,filter .12s}
.ab-btn:focus-visible,.ab-tab:focus-visible,.ab-switch:focus-visible,.ab-choice:focus-visible{outline:none;box-shadow:0 0 0 3px var(--ab-foam-2)}
.ab-btn.primary{box-shadow:0 2px 8px color-mix(in srgb,var(--ab-sea) 30%,transparent)}
.ab-btn.danger:hover{background:rgba(207,34,46,.07);border-color:rgba(207,34,46,.3)}
.ab-switch{width:40px;height:23px}.ab-switch:after{width:17px;height:17px}.ab-switch.on:after{left:20px}
.ab-note{border-radius:12px;padding:11px 14px;line-height:1.6}
.ab-choice{border-radius:14px;padding:12px 14px}
.ab-choice.on b{color:var(--ab-deep)}
.ab-li{padding:11px 4px;border-radius:8px}
.ab-li:hover{background:var(--ab-hover)}
.ab-sticker{border-radius:14px;transition:transform .12s,box-shadow .12s}
.ab-sticker:hover{transform:translateY(-2px);box-shadow:var(--ab-shadow)}
.ab-pitem{border-radius:12px;transition:border-color .12s,box-shadow .12s}
.ab-mood{height:12px}
.ab-mood > i{background:linear-gradient(90deg,#9ad0ff,var(--ab-sea) 60%,#7a6cf0)}
.ab-logs{border-radius:12px;border:1px solid var(--ab-line)}
.ab-savebar{border-radius:14px;backdrop-filter:blur(8px)}
.ab-table th{font-size:12px;letter-spacing:.02em}
.ab-table tr:hover td{background:var(--ab-hover)}
.ab-checks{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px}
.ab-check{display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:12px;border:1px solid var(--ab-line);background:var(--ab-card-2);color:var(--ab-sub);font-size:12.5px}
.ab-check i{font-style:normal;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--ab-line-2);color:#fff;flex:none}
.ab-check.done{color:var(--ab-text);border-color:color-mix(in srgb,var(--ab-ok) 30%,transparent);background:color-mix(in srgb,var(--ab-ok) 7%,var(--ab-card))}
.ab-check.done i{background:var(--ab-ok)}
.ab-drop{border-radius:14px;background:var(--ab-card-2)}
.ab-drives{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.ab-drive{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;padding:9px 12px;border-radius:12px;border:1px solid var(--ab-line-2);background:var(--ab-card);color:var(--ab-text);font:inherit;cursor:pointer;transition:border-color .12s,box-shadow .12s}
.ab-drive:hover{border-color:var(--ab-sky)}
.ab-drive.on{border-color:var(--ab-sea);box-shadow:0 0 0 3px var(--ab-foam);background:linear-gradient(var(--ab-foam),var(--ab-foam)),var(--ab-card)}
.ab-drive b{font-weight:600}.ab-drive small{color:var(--ab-dim);font-size:11.5px;word-break:break-all}
.ab-drive .bar{display:block;width:100%;height:4px;border-radius:999px;background:var(--ab-card-2);overflow:hidden;margin-top:4px}
.ab-drive .bar i{display:block;height:100%;background:var(--ab-sky)}
.ab-drive.low .bar i{background:var(--ab-warn)}
.ab-install{margin-top:12px;padding:14px 16px;border-radius:14px;border:1px solid var(--ab-foam-2);background:var(--ab-foam)}
.ab-install-steps{display:flex;gap:6px}
.ab-install-steps .st{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11.5px;color:var(--ab-dim);text-align:center;position:relative}
.ab-install-steps .st:before{content:"";position:absolute;top:11px;left:-50%;right:50%;height:2px;background:var(--ab-line-2);z-index:0}
.ab-install-steps .st:first-child:before{display:none}
.ab-install-steps .st.done:before,.ab-install-steps .st.on:before{background:var(--ab-sea)}
.ab-install-steps .st i{position:relative;z-index:1;font-style:normal;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--ab-card);border:2px solid var(--ab-line-2);color:var(--ab-dim)}
.ab-install-steps .st.done i{background:var(--ab-sea);border-color:var(--ab-sea);color:#fff}
.ab-install-steps .st.on i{border-color:var(--ab-sea);color:var(--ab-sea);box-shadow:0 0 0 4px var(--ab-foam-2)}
.ab-install-steps .st.on{color:var(--ab-deep);font-weight:600}
.ab-install-steps .st span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ab-install-dl{display:flex;flex-wrap:wrap;gap:10px 24px;align-items:center;margin-top:10px}
.ab-install-dl small{display:block;color:var(--ab-dim);font-size:11px}
.ab-install-dl b{font-size:18px;font-variant-numeric:tabular-nums}
@media (max-width:640px){.ab-install-steps .st span{display:none}}
@media (max-width:640px){.ab-row .ab-label{flex:none}.ab-row .ab-label small{max-width:none}}
@media (prefers-reduced-motion:reduce){.ab-root *{transition:none!important;animation:none!important}}
.ab-badge.dim{background:var(--ab-card-2);color:var(--ab-sub);border:1px solid var(--ab-line)}
.ab-badge.warn{background:rgba(191,135,0,.14);color:#9a6700;border:1px solid rgba(191,135,0,.3)}
.ab-badge.err{background:rgba(207,34,46,.1);color:var(--ab-err);border:1px solid rgba(207,34,46,.3)}
.ab-badge.mine{background:var(--ab-deep)}
.ab-mod{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--ab-line)}
.ab-mod:first-child{border-top:0}
.ab-mod .main{flex:1;min-width:0}
.ab-mod .nm{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-weight:600}
.ab-mod .nm code{font-weight:400;font-size:11.5px;color:var(--ab-dim)}
.ab-mod .ds{color:var(--ab-sub);font-size:12.5px;margin-top:2px}
.ab-mod .what{color:var(--ab-dim);font-size:11.5px;margin-top:4px;word-break:break-word}
.ab-mod .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.ab-mod .side{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.ab-code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;background:var(--ab-card-2);border:1px solid var(--ab-line);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-all;margin:6px 0 0}
`
    function useStyle() {
      useEffect(() => {
        if (document.getElementById('aurabot-style')) return
        const el = document.createElement('style')
        el.id = 'aurabot-style'
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ---------------- 图标 ----------------
    function WhaleIcon({ size }) {
      const s = size || 16
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 13c0 3.6 3.3 6 8 6 4.6 0 8.2-2.7 8.7-6.6.1-.8.8-1.4 1.6-1.4H22c-.3-1.6-1.6-2.6-3-2.6-1.8 0-3 1.2-3.6 2.6H9c-3.4 0-6 .4-6 2Z' }),
        h('path', { d: 'M7.5 3.5c.8.9.9 2.3.2 3.3M10.5 3.5c-.8.9-.9 2.3-.2 3.3M9 6.8V9' }),
        h('circle', { cx: 7.3, cy: 13.3, r: 0.6, fill: 'currentColor' }),
      )
    }

    // ---------------- 基础控件 ----------------
    function Switch({ on, onChange, disabled, title }) {
      return h('button', { type: 'button', className: cx('ab-switch', on && 'on'), onClick: () => !disabled && onChange(!on), disabled, title, role: 'switch', 'aria-checked': !!on })
    }
    function Row({ label, hint, children }) {
      return h('div', { className: 'ab-row' }, h('div', { className: 'ab-label' }, h('b', null, label), hint ? h('small', null, hint) : null), h('div', { className: 'ab-ctl' }, children))
    }
    function Card({ title, desc, icon, right, children, className }) {
      return h('div', { className: cx('ab-card', className) },
        title ? h('div', { className: 'ab-flex', style: { marginBottom: desc ? 0 : 10 } }, h('h3', null, icon || null, title), h('div', { className: 'ab-spacer' }), right || null) : null,
        desc ? h('p', { className: 'ab-desc' }, desc) : null,
        children)
    }
    function Btn({ kind, small, onClick, disabled, children, title }) {
      const [busy, setBusy] = useState(false)
      return h('button', {
        type: 'button', title, className: cx('ab-btn', kind, small && 'sm'), disabled: disabled || busy,
        onClick: async () => { if (!onClick) return; setBusy(true); try { await onClick() } finally { setBusy(false) } },
      }, busy ? [h('i', { key: 's', className: 'ab-spin' }), ' 处理中'] : children)
    }

    /** 自定义下拉：替代系统自带的蓝白 select。options: [{value, label, desc?, group?}] */
    function Select({ value, options, onChange, placeholder, width }) {
      const [open, setOpen] = useState(false)
      const [act, setAct] = useState(-1)
      const ref = useRef(null)
      const cur = options.find((o) => o.value === value)
      useEffect(() => {
        if (!open) return
        const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
        document.addEventListener('mousedown', close)
        return () => document.removeEventListener('mousedown', close)
      }, [open])
      const pick = (o) => { onChange(o.value); setOpen(false) }
      const openAt = () => { setOpen(true); setAct(Math.max(0, options.indexOf(cur))) }
      const onKey = (e) => {
        if (e.key === 'Escape') { setOpen(false); return }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (!open) return openAt()
          setAct((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (open && options[act]) pick(options[act])
          else openAt()
        }
      }
      let lastGroup = null
      const items = []
      options.forEach((o, i) => {
        if (o.group && o.group !== lastGroup) items.push(h('div', { key: 'g' + i, className: 'ab-sel-group' }, o.group))
        lastGroup = o.group || lastGroup
        items.push(h('div', { key: 'o' + i, role: 'option', 'aria-selected': o.value === value, className: cx('ab-sel-opt', o.value === value && 'on', i === act && 'act'), onMouseEnter: () => setAct(i), onMouseDown: (e) => { e.preventDefault(); pick(o) } },
          h('span', { className: 'ck' }, o.value === value ? '✓' : ''),
          h('span', { className: 'tx' }, o.label, o.desc ? h('span', { className: 'ds' }, o.desc) : null)))
      })
      return h('div', { className: cx('ab-sel', open && 'open'), ref, style: width ? { minWidth: width } : null },
        h('button', { type: 'button', className: 'ab-sel-btn', onClick: () => (open ? setOpen(false) : openAt()), onKeyDown: onKey, 'aria-haspopup': 'listbox', 'aria-expanded': open },
          h('span', { className: 'v' }, cur ? cur.label : h('span', { className: 'ab-muted' }, placeholder || '请选择')),
          h('svg', { className: 'chev', width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' }))),
        open ? h('div', { className: 'ab-sel-pop', role: 'listbox' }, items) : null)
    }

    /** 卡片式单选：选项少、需要解释时用。 */
    function Choices({ value, options, onChange }) {
      return h('div', { className: 'ab-choices', role: 'radiogroup' }, options.map((o) => h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': o.value === value, className: cx('ab-choice', o.value === value && 'on'), onClick: () => onChange(o.value) },
        h('b', null, o.icon || null, o.label), o.desc ? h('small', null, o.desc) : null)))
    }

    /** 滑块 + 数值，比纯数字框直观。 */
    function Range({ value, min, max, step, onChange, fmt }) {
      return h('div', { className: 'ab-range' },
        h('input', { type: 'range', min, max, step: step || 1, value: value ?? min, onChange: (e) => onChange(Number(e.target.value)) }),
        h('span', { className: 'val' }, fmt ? fmt(value) : value))
    }
    function Seg({ value, options, onChange, disabled }) {
      return h('div', { className: 'ab-seg' + (disabled ? ' off' : '') }, options.map((o) => h('button', { key: o.value, type: 'button', className: value === o.value ? 'on' : '', disabled: !!disabled, onClick: () => { if (!disabled) onChange(o.value) } }, o.label)))
    }
    function Empty({ icon, text }) {
      return h('div', { className: 'ab-empty' }, h('div', { className: 'big' }, icon || '🐋'), text)
    }

    /** 一行一个的列表框：输入时保留原文（含正在敲的空行），只把解析结果交给草稿。 */
    function ListArea({ value, onChange, placeholder, numbers }) {
      const parse = (t) => t.split(numbers ? /[\n,，;；\s]+/ : /[\n,，;；]+/).map((s) => s.trim()).filter(Boolean)
      const [text, setText] = useState(value.join('\n'))
      // 外面改了（保存、撤销、重新载入）而且和框里内容对不上时才覆盖
      useEffect(() => { if (parse(text).join('\n') !== value.join('\n')) setText(value.join('\n')) }, [value.join('\n')])
      return h('textarea', { className: 'ab-textarea', style: { minHeight: 60 }, placeholder, value: text,
        onChange: (e) => { setText(e.target.value); onChange(parse(e.target.value)) },
        onBlur: () => setText(parse(text).join('\n')) })
    }

    // 绑定到草稿配置的控件
    function useField(draft, setDraft) {
      return {
        sw: (path, extra) => h(Switch, { on: !!getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), ...(extra || {}) }),
        text: (path, props) => h('input', { className: cx('ab-input', props && props.size), value: getPath(draft, path) ?? '', placeholder: props && props.placeholder, type: (props && props.type) || 'text', onChange: (e) => setDraft(setPath(draft, path, e.target.value)) }),
        num: (path, props) => h('input', { className: 'ab-input sm', type: 'number', min: props && props.min, max: props && props.max, step: (props && props.step) || 1, value: getPath(draft, path) ?? '', onChange: (e) => setDraft(setPath(draft, path, e.target.value === '' ? '' : Number(e.target.value))) }),
        percent: (path) => h(Range, { min: 0, max: 100, value: pct(getPath(draft, path)), onChange: (v) => setDraft(setPath(draft, path, v / 100)), fmt: (v) => v + '%' }),
        range: (path, min, max, step, fmt) => h(Range, { min, max, step, value: getPath(draft, path), onChange: (v) => setDraft(setPath(draft, path, v)), fmt }),
        list: (path, props) => h(ListArea, { value: getPath(draft, path) || [], placeholder: props && props.placeholder, numbers: props && props.numbers, onChange: (v) => setDraft(setPath(draft, path, v)) }),
        select: (path, options, props) => h(Select, { value: getPath(draft, path) ?? '', options, onChange: (v) => setDraft(setPath(draft, path, v)), ...(props || {}) }),
        choices: (path, options) => h(Choices, { value: getPath(draft, path), options, onChange: (v) => setDraft(setPath(draft, path, v)) }),
      }
    }

    // ---------------- 标签页 ----------------
    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'new-features', label: '聊天与功能设置' },
      { id: 'connect', label: '连接' },
      { id: 'persona', label: '人格' },
      { id: 'access', label: '权限' },
      { id: 'group', label: '聊天', flag: 'group' },
      { id: 'model', label: '模型' },
      { id: 'voice', label: '语音', flag: 'voice.enabled' },
      { id: 'stickers', label: '表情包', flag: 'stickers.enabled' },
      { id: 'imagegen', label: '生图', flag: 'imageGen.enabled' },
      { id: 'search', label: '搜索', flag: 'search.enabled' },
      { id: 'speakup', label: '主动搭话', flag: 'speakUp.enabled' },
      { id: 'mood', label: '心情', flag: 'mood.enabled' },
      { id: 'memory', label: '记忆', flag: 'memory.enabled' },
      { id: 'retrieval', label: '检索与索引', flag: 'retrieval.enabled' },
      { id: 'media-memory', label: '图片理解', flag: 'mediaMemory.enabled' },
      { id: 'learning', label: '表达与黑话', flag: 'learning.enabled' },
      { id: 'tasks', label: '任务' },
      { id: 'song', label: '翻唱', flag: 'song.enabled' },
      { id: 'bili', label: 'B站', flag: 'bili.enabled' },
      { id: 'local', label: '本地接口' },
      { id: 'modules', label: '扩展' },
      { id: 'token-meter', label: 'Token 统计' },
      { id: 'diagnostics', label: '诊断' },
      { id: 'logs', label: '日志' },
    ]
    // 内置标签页属于哪个模块：模块都没在跑就不显示这一页
    const TAB_MODS = { voice: ['voice'], stickers: ['stickers'], imagegen: ['imagegen'], search: ['search'], speakup: ['speakup'], mood: ['mood'], memory: ['memory'], retrieval:['retrieval'], 'media-memory':['media-memory'], learning: ['learning'], tasks: ['tasks'], song: ['song'], bili: ['bili'], 'token-meter': ['token-meter'] }
    const modOn = (st, id) => (st.modules || []).some((m) => m.id === id && m.running)
    function ModOff({ name }) {
      return h(Card, { title: name }, h('div', { className: 'ab-muted ab-small' }, '「' + name + '」模块关着，这部分用不了。要用的话去「扩展」页把它打开。'))
    }
    /** 一个标签页出错时只坏这一页：显示原因和「回到概览」，不会整个面板白屏（也不会因为记住了这一页而一直白）。 */
    class TabBoundary extends React.Component {
      constructor(p) { super(p); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      componentDidCatch(error) { try { localStorage.setItem('aurabot.tab', 'overview') } catch (e) {} }
      render() {
        if (!this.state.error) return this.props.children
        return h(Card, { title: '这一页出错了' },
          h('div', { className: 'ab-note err' }, String((this.state.error && this.state.error.message) || this.state.error)),
          h('div', { className: 'ab-small ab-muted', style: { margin: '8px 0' } }, '别的页面不受影响。把这段报错截图发给作者就行。'),
          h('div', { className: 'ab-flex' },
            h(Btn, { small: true, kind: 'primary', onClick: () => this.props.onHome && this.props.onHome() }, '回到概览'),
            h(Btn, { small: true, kind: 'ghost', onClick: () => this.setState({ error: null }) }, '再试一次')))
      }
    }
    const copy = (text, toast, msg) => { try { navigator.clipboard.writeText(text); if (msg) toast(msg, 'ok') } catch (e) { toast('复制失败，手动选中复制吧', 'err') } }

    /** 更新提示：GitHub 上有新版本时给更新命令；刚更新完显示一次这次更新了什么。 */
    function UpdateNotes({ st, toast }) {
      const [upd, setUpd] = useState(null)
      const [notes, setNotes] = useState(null)
      useEffect(() => {
        get('/update/check').then(setUpd).catch(() => {})
        let seen = null
        try { seen = localStorage.getItem('aurabot.seenVersion') } catch (e) {}
        if (seen && seen !== st.version) get('/changelog').then((r) => r.notes && setNotes(r.notes))
        // 第一次打开（新安装）不弹更新说明，直接记下当前版本
        else if (!seen) { try { localStorage.setItem('aurabot.seenVersion', st.version) } catch (e) {} }
      }, [st.version])
      const dismiss = () => { try { localStorage.setItem('aurabot.seenVersion', st.version) } catch (e) {} setNotes(null) }
      return h(Fragment, null,
        notes ? h('div', { className: 'ab-note' },
          h('div', { className: 'ab-flex' }, h('b', null, '已更新到 v' + st.version), h('div', { className: 'ab-spacer' }), h(Btn, { small: true, kind: 'ghost', onClick: dismiss }, '知道了')),
          h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6 } }, notes)) : null,
        upd && upd.newer ? h('div', { className: 'ab-note warn' },
          h('div', null, h('b', null, '有新版本 v' + upd.latest), '（现在是 v' + upd.current + '）。在 PowerShell 里运行下面这行，然后重启 DSH；设置、人格、记忆都会保留。'),
          h('div', { className: 'ab-flex', style: { marginTop: 6 } },
            h('code', { style: { flex: '1 1 300px', fontSize: 11.5, wordBreak: 'break-all' } }, upd.command),
            h(Btn, { small: true, onClick: () => { try { navigator.clipboard.writeText(upd.command); toast('复制好了', 'ok') } catch (e) { toast('复制失败，手动选中复制吧', 'err') } } }, '复制'))) : null)
    }

    function Overview({ st, toast, go }) {
      const cfg = st.config
      const s = st.stats || {}
      const conn = st.onebot.state === 'connected'
      const quick = (p, body) => async () => { const r = await post(p, body); toast(r.message || (r.ok ? '好了' : '没成功')) }
      return h('div', { className: 'ab-grid' },
        h(UpdateNotes, { st, toast }),
        !cfg.enabled ? h('div', { className: 'ab-note warn' }, '总开关是关着的：大肥鱼现在不会收也不会发任何 QQ 消息。准备好了就在右上角打开。') : null,
        cfg.enabled && cfg.dryRun ? h('div', { className: 'ab-note' }, '现在是试运行：她会照常思考回复，但只写进日志，不会真的发到 QQ。确认没问题后在右上角关掉「试运行」。') : null,
        cfg.enabled && !conn ? h('div', { className: 'ab-note err' }, '还没连上 QQ 网关' + (st.onebot.problem ? '：' + st.onebot.problem + '。' : '。去「连接」标签看看 SnowLuma 有没有装好、启动没有。') + ' ', h('a', { href: '#', onClick: (e) => { e.preventDefault(); go('connect') } }, '去连接 →')) : null,
        h('div', { className: 'ab-grid ab-g4' },
          [['今天收到', s.received, '📥'], ['今天发出', s.sent, '📤'], ['语音条', s.voice, '🎙️'], ['表情包', s.stickers, '😺']].map(([l, n, ic]) => h('div', { key: l, className: 'ab-card ab-stat' }, h('span', { className: 'ic', 'aria-hidden': true }, ic), h('div', { className: 'n' }, n || 0), h('div', { className: 'l' }, l))),
        ),
        h('div', { className: 'ab-grid ab-g2' },
          h(Card, { title: '她现在', desc: '心情会随聊天起伏，过一阵子慢慢回到平常。' },
            h('div', { className: 'ab-flex', style: { marginBottom: 8 } }, h('b', null, st.mood.label), h('span', { className: 'ab-muted' }, st.mood.value + ' / 100')),
            h('div', { className: 'ab-mood' }, h('i', { style: { width: Math.max(4, st.mood.value) + '%' } })),
            h('div', { className: 'ab-kv', style: { marginTop: 14 } },
              h('span', null, '表情库'), h('span', null, st.stickers.count + ' 张'),
              h('span', null, '人格'), h('span', null, (st.personas.find((p) => p.id === cfg.persona.current) || {}).name || cfg.persona.current),
              h('span', null, 'QQ 会话'), h('span', null, Object.keys(st.sessions || {}).filter((k) => !k.startsWith('system:')).length + ' 个（在侧栏「Aurabot · QQ」工作区里）'),
            ),
          ),
          h(Card, { title: '快捷操作', desc: '试一试她是不是活着。这些操作会真的发到 QQ（试运行时只写日志）。' },
            h('div', { className: 'ab-flex' },
              h(Btn, { kind: 'primary', onClick: quick('/test-send') }, '给主人发一条自测'),
              h(Btn, { onClick: quick('/speakup/fire') }, '让她现在来找你'),
            ),
            h('p', { className: 'ab-muted ab-small', style: { marginTop: 12, marginBottom: 0 } }, '想看她和每个人聊了什么、调了什么工具：点 DSH 侧栏「Aurabot · QQ」工作区里对应的会话，也可以直接在会话里插话。'),
            h('div', { className: 'ab-flex', style: { marginTop: 10 } },
              h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('把现在所有 QQ 会话归档、让她从头开始聊？（旧会话在侧栏的归档里还能找到）')) return; const r = await post('/sessions/reset'); toast(r.message) } }, '重新开始所有 QQ 会话')),
          ),
        ),
        h(RecentLogs, { go }),
      )
    }

    function RecentLogs({ go }) {
      const [items, setItems] = useState(null)
      useEffect(() => {
        let alive = true
        const load = () => get('/logs?limit=8&level=info').then((r) => alive && setItems(r.entries || []))
        load()
        const t = setInterval(load, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])
      return h(Card, { title: '最近动态', right: h(Btn, { kind: 'ghost', small: true, onClick: () => go('logs') }, '全部日志 →') },
        items === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : items.length === 0 ? h(Empty, { text: '还没有动静' }) :
          h('div', { className: 'ab-logs', style: { maxHeight: 240 } }, items.slice().reverse().map((e, i) => h(LogLine, { key: i, e }))))
    }

    function LogLine({ e }) {
      return h('div', { className: cx('ab-log', e.level) }, h('span', { className: 't' }, e.time), h('span', { className: 'a' }, e.area), h('span', { className: 'm' }, e.text))
    }

    /** 控制台密码状态：插件自动管理；登不上时给「重置为自动密码」。 */
    function SnowLumaAuth({ running, toast, onChange }) {
      const [s, setS] = useState(null)
      const load = () => get('/snowluma/login-check').then(setS)
      useEffect(() => { if (running) load() }, [running])
      if (!running) return h('span', { className: 'ab-muted ab-small' }, '启动后插件会自动管理控制台密码，你不用设置。')
      if (!s) return h('span', { className: 'ab-muted ab-small' }, h('i', { className: 'ab-spin' }), ' 检查中…')
      if (s.ok) return h(PasswordPeek, { toast, auto: s.passwordAuto })
      return h('div', null,
        h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '插件登不上 SnowLuma 控制台：' + (s.message || '') + '。多半是之前手动设过密码。'),
        h('div', { style: { marginTop: 6 } }, h(Btn, { small: true, kind: 'primary', onClick: async () => {
          if (!confirm('会先停掉 SnowLuma、清掉它的旧控制台密码，再用插件生成的新密码重新启动。机器人号需要稍后重新接入。继续吗？')) return
          const r = await post('/snowluma/reset-password'); toast(r.message); load(); onChange && onChange()
        } }, '重置为自动密码')))
    }

    /** 控制台密码：插件登得上时显示状态，能看一眼、复制（打开 SnowLuma 自己的控制台要用）。 */
    function PasswordPeek({ toast, auto }) {
      const [pw, setPw] = useState('')
      const peek = async () => { const r = await get('/snowluma/password'); setPw(r.password || '（还没有）') }
      return h('div', { className: 'ab-flex' },
        h('span', { className: 'ab-small', style: { color: 'var(--ab-ok)' } }, auto ? '✓ 控制台密码由插件自动管理' : '✓ 用的是你设的控制台密码'),
        pw ? h('code', { className: 'ab-small' }, pw) : null,
        h(Btn, { small: true, kind: 'ghost', onClick: () => (pw ? setPw('') : peek()) }, pw ? '隐藏' : '显示密码'),
        h(Btn, { small: true, kind: 'ghost', onClick: async () => { const r = await get('/snowluma/password'); copy(r.password || '', toast, '密码复制好了，打开 SnowLuma 控制台时粘贴') } }, '复制密码'))
    }

    /** 在面板里阅读并同意 SnowLuma 的用户协议和隐私说明（必须由用户本人勾选、点击）。 */
    function Agreement({ running, toast, onChange }) {
      const [a, setA] = useState(null)
      const [tab, setTab] = useState(0)
      const [agree, setAgree] = useState(false)
      const load = () => get('/snowluma/agreements').then(setA)
      useEffect(() => { if (running) load() }, [running])
      if (!running) return h('span', { className: 'ab-muted ab-small' }, '先启动 SnowLuma。')
      if (!a) return h('span', { className: 'ab-muted ab-small' }, h('i', { className: 'ab-spin' }), ' 读取协议…')
      if (!a.ok) return h('span', { className: 'ab-small', style: { color: 'var(--ab-warn)' } }, '读不到协议：' + a.message)
      if (!a.consentRequired) return h('span', { className: 'ab-small', style: { color: 'var(--ab-ok)' } }, '✓ 已同意 SnowLuma 的用户协议和隐私说明（版本 ' + a.version + '）')
      const doc = a.documents[tab] || a.documents[0]
      return h('div', { style: { width: '100%' } },
        h('div', { className: 'ab-seg', style: { marginBottom: 8 } }, a.documents.map((d, i) => h('button', { key: d.id, type: 'button', className: i === tab ? 'on' : '', onClick: () => setTab(i) }, d.title.split('/')[0].trim()))),
        doc ? h('div', { className: 'ab-logs', style: { maxHeight: 260, padding: '12px 14px', fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.7, whiteSpace: 'pre-wrap' } }, doc.text) : null,
        h('label', { className: 'ab-flex', style: { marginTop: 10, cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: agree, onChange: (e) => setAgree(e.target.checked), style: { accentColor: 'var(--ab-sea)', width: 16, height: 16 } }),
          h('span', null, '我已阅读并同意以上 SnowLuma 用户协议和隐私说明')),
        h('div', { className: 'ab-flex', style: { marginTop: 8 } },
          h(Btn, { kind: 'primary', small: true, disabled: !agree, onClick: async () => { const r = await post('/snowluma/consent', { version: a.version, agree: true }); toast(r.ok ? '已同意' : r.message, r.ok ? 'ok' : 'err'); load(); onChange && onChange() } }, '同意'),
          h('span', { className: 'ab-muted ab-small' }, 'SnowLuma 是独立的第三方项目，仅限个人非商业使用；使用非官方 QQ 工具有账号风险，请用小号。')))
    }

    function Connect({ st, draft, setDraft, toast, reload, openWizard }) {
      const f = useField(draft, setDraft)
      const sl = st.snowluma
      const [procs, setProcs] = useState(null)
      const conn = st.onebot.state === 'connected'
      const loadProcs = async () => { const r = await get('/snowluma/processes'); setProcs(r.list || []); if (!r.ok) toast(r.message) }
      const act = (p) => async () => { const r = await post(p); toast(r.message || (r.ok ? '好了' : '没成功')); reload() }
      const login = st.onebot.login
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '接上 QQ（SnowLuma）', desc: 'SnowLuma 是让机器人号上线的 QQ 网关。按协议规定它需要你自己下载、解压并同意它的用户协议；控制台密码、启动、接入、断线重连都交给 Aurabot。',
          right: openWizard ? h(Btn, { small: true, kind: 'ghost', onClick: openWizard }, '重新走一遍设置向导') : null },
          h('div', { className: 'ab-steps' },
            h('div', { className: cx('ab-step', sl.installed && 'done') }, h('div', null,
              h('b', null, '下载 SnowLuma'), h('div', { className: 'ab-muted ab-small' }, '打开官方发布页，下载 Windows 完整版（名字类似 SnowLuma-v2.x.x-win-x64.zip，不带 lite）。'),
              h('div', { style: { marginTop: 6 } }, h(Btn, { small: true, onClick: () => window.open(sl.downloadPage, '_blank') }, '打开下载页 ↗')))),
            h('div', { className: cx('ab-step', sl.installed && 'done') }, h('div', null,
              h('b', null, '解压到一个纯英文的目录'), h('div', { className: 'ab-muted ab-small' }, '推荐 C:\\Aurabot\\snowluma。解压后这个目录里应该直接能看到 index.mjs 和 node.exe。'),
              h('div', { className: 'ab-flex', style: { marginTop: 6 } }, f.text('snowluma.dir', { size: 'wide', placeholder: 'C:\\Aurabot\\snowluma' })),
              !sl.installed && sl.reason ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)', marginTop: 4 } }, sl.reason) : sl.installed ? h('div', { className: 'ab-small', style: { color: 'var(--ab-ok)', marginTop: 4 } }, '找到了 SnowLuma v' + sl.version) : null)),
            h('div', { className: cx('ab-step', sl.running && 'done') }, h('div', null,
              h('b', null, '启动'), h('div', { className: 'ab-muted ab-small' }, '后台运行，不弹窗口；以后会跟着 DSH 自动启动。'),
              h('div', { className: 'ab-flex', style: { marginTop: 6 } },
                h(Btn, { small: true, kind: 'primary', disabled: !sl.installed || sl.running, onClick: act('/snowluma/start') }, sl.running ? '已在运行' : '启动'),
                sl.owns ? h(Btn, { small: true, kind: 'danger', onClick: act('/snowluma/stop') }, '停止') : null),
              h('div', { style: { marginTop: 6 } }, h(SnowLumaAuth, { running: sl.running, toast, onChange: reload })))),
            h('div', { className: cx('ab-step', sl.consented && 'done') }, h('div', null,
              h('b', null, '阅读并同意 SnowLuma 的用户协议'), h('div', { className: 'ab-muted ab-small', style: { marginBottom: 6 } }, '同意之前 SnowLuma 不会工作。'),
              h(Agreement, { running: sl.running, toast, onChange: reload }))),
            h('div', { className: cx('ab-step', conn && login && login.uin === draft.botQQ && 'done') }, h('div', null,
              h('b', null, '登录机器人号并接入'), h('div', { className: 'ab-muted ab-small' }, '在电脑上另开一个 QQ 登录机器人号 ' + draft.botQQ + '（可以最小化），然后点「接入机器人号」。'),
              h('div', { className: 'ab-flex', style: { marginTop: 6 } },
                h(Btn, { small: true, kind: 'primary', disabled: !sl.running, onClick: act('/snowluma/attach') }, '接入机器人号'),
                h(Btn, { small: true, disabled: !sl.running, onClick: loadProcs }, '看看有哪些 QQ 进程'),
                h(Btn, { small: true, onClick: async () => { const r = await get('/onebot/test'); toast(r.message) } }, '测试连接')),
              sl.lastAttach && sl.lastAttach.at ? h('div', { className: 'ab-small', style: { marginTop: 4, color: sl.lastAttach.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, timeAgo(sl.lastAttach.at) + '：' + sl.lastAttach.message) : null)),
          ),
          procs ? h('div', { style: { marginTop: 14 } }, procs.length === 0 ? h('div', { className: 'ab-muted' }, '没找到 QQ 进程。') :
            h('table', { className: 'ab-table' }, h('thead', null, h('tr', null, ['进程', '登录的号', '昵称', '状态', ''].map((x) => h('th', { key: x }, x)))),
              h('tbody', null, procs.map((p) => h('tr', { key: p.pid },
                h('td', null, p.pid), h('td', null, p.uin || '识别不出'), h('td', null, p.nickname || '—'),
                h('td', null, p.injected ? (p.connected ? '已接入' : '已注入，连接中') : '未接入'),
                h('td', null, p.isBot ? h('span', { className: 'ab-badge' }, '机器人号') : h('span', { className: 'ab-muted ab-small' }, '不会碰'))))))) : null,
        ),
        h(Card, { title: '连接状态' },
          h('div', { className: 'ab-kv' },
            h('span', null, 'QQ 网关'), h('span', null, h('span', { className: 'ab-flex' }, h('i', { className: cx('ab-dot', conn ? 'ok' : st.onebot.state === 'connecting' ? 'warn' : 'err') }), { connected: '已连上', connecting: '连接中', disconnected: '断开了，正在重连', stopped: '没启动（总开关关着）', unconfigured: '还没配置' }[st.onebot.state] || st.onebot.state)),
            h('span', null, '登录的号'), h('span', null, login ? login.nickname + '（' + login.uin + '）' + (login.uin !== draft.botQQ ? ' ⚠ 不是机器人号！' : '') : '—'),
            h('span', null, 'HTTP'), h('span', null, st.onebot.endpoint.httpUrl || '—'),
            h('span', null, 'WebSocket'), h('span', null, st.onebot.endpoint.wsUrl || '—'),
          ),
          !conn && st.onebot.problem ? h('div', { className: 'ab-note warn', style: { marginTop: 10 } }, st.onebot.problem) : null,
          h('div', { className: 'ab-flex', style: { marginTop: 10 } }, h(Btn, { small: true, onClick: async () => { const r = await post('/onebot/reconnect'); toast(r.message, r.ok ? 'ok' : 'err'); reload() } }, '重新连接')),
        ),
        h(Card, { title: '高级', desc: '一般不用动：地址和令牌会自动从 SnowLuma 的配置里读。' },
          h(Row, { label: '机器人 QQ 号' }, f.text('botQQ')),
          h(Row, { label: '控制台端口' }, f.num('snowluma.webuiPort', { min: 1, max: 65535 })),
          h(Row, { label: '控制台密码', hint: '默认由插件自动生成，上面「显示密码」能看到。想自己定一个就填在这里，保存后会真的改到 SnowLuma 上（至少 10 位，要有大小写字母和符号，不能有空格）' }, f.text('snowluma.webuiPassword', { type: 'password', placeholder: draft.snowluma.webuiPasswordSet ? (draft.snowluma.passwordAuto ? '自动管理中（不改就留空）' : '已保存（不改就留空）') : '留空 = 自动' })),
          h(Row, { label: 'SnowLuma 自己的控制台', hint: '一般用不到，想看它的原始界面时用' }, h(Btn, { small: true, disabled: !sl.running, onClick: () => window.open(sl.webui, '_blank') }, '打开 ↗')),
          h(Row, { label: '随 DSH 自动启动 SnowLuma' }, f.sw('snowluma.autoStart')),
          h(Row, { label: '自动接入机器人号', hint: '断线后自动重新接入，只接机器人号。' }, f.sw('snowluma.autoAttach')),
          h(Row, { label: '手动 HTTP 地址', hint: '留空 = 自动' }, f.text('snowluma.httpUrl', { placeholder: 'http://127.0.0.1:3000' })),
          h(Row, { label: '手动 WS 地址', hint: '留空 = 自动' }, f.text('snowluma.wsUrl', { placeholder: 'ws://127.0.0.1:3001' })),
          h(Row, { label: '手动 HTTP 令牌' }, f.text('snowluma.httpToken', { type: 'password', placeholder: draft.snowluma.httpTokenSet ? '已保存' : '留空 = 自动' })),
          h(Row, { label: '手动 WS 令牌' }, f.text('snowluma.wsToken', { type: 'password', placeholder: draft.snowluma.wsTokenSet ? '已保存' : '留空 = 自动' })),
        ),
      )
    }

    /** 选一张图片当头像（最多 5MB）。 */
    async function pickAvatar(toast, reload) {
      const inp = document.createElement('input')
      inp.type = 'file'
      inp.accept = 'image/png,image/jpeg,image/gif,image/webp'
      const file = await new Promise((res) => { inp.onchange = () => res(inp.files && inp.files[0]); inp.click() })
      if (!file) return
      if (file.size > 5 * 1024 * 1024) return toast('图片太大了，最多 5MB', 'err')
      const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(file) })
      const r = await post('/avatar/upload', { data })
      toast(r.message, r.ok ? 'ok' : 'err')
      reload()
    }
    const avatarSrc = (st) => API + '/avatar?v=' + ((st.avatar && st.avatar.at) || 0)

    function AvatarCard({ st, toast, reload }) {
      const custom = st.avatar && st.avatar.custom
      return h('div', { className: 'ab-card', style: { marginTop: 12, padding: 14 } },
        h('div', { className: 'ab-flex', style: { alignItems: 'center', gap: 12 } },
          h('img', { src: avatarSrc(st), alt: '头像', style: { width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', objectPosition: '50% 18%', border: '2px solid var(--ab-line)' } }),
          h('div', null, h('b', null, '头像'), h('div', { className: 'ab-muted ab-small' }, custom ? '用的是你上传的图片' : '默认的大肥鱼'))),
        h('div', { className: 'ab-flex', style: { marginTop: 10, flexWrap: 'wrap' } },
          h(Btn, { small: true, kind: 'primary', onClick: () => pickAvatar(toast, reload) }, '换一张'),
          custom ? h(Btn, { small: true, kind: 'ghost', onClick: async () => { const r = await post('/avatar/reset'); toast(r.message, 'ok'); reload() } }, '恢复默认') : null,
          h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('把这张图设成机器人号的 QQ 头像？')) return; const r = await post('/avatar/sync-qq'); toast(r.message, r.ok ? 'ok' : 'err') } }, '同步成 QQ 头像')),
        h('div', { className: 'ab-muted ab-small', style: { marginTop: 6 } }, '这是面板里显示的头像；点「同步成 QQ 头像」才会改机器人号在 QQ 上的头像。'))
    }

// ---------------- 人格：卡片列表 + 分层编辑（草稿 / 发布 / 历史 / 回滚）+ 绑定 ----------------
    const PROACTIVITY = [{ value: 'low', label: '话少' }, { value: 'normal', label: '正常' }, { value: 'high', label: '话多' }]
    const ORIGIN = { builtin: '内置', legacy: '旧版导入', user: '自己建的', import: '导入的' }
    const blankLayers = () => ({ identity: { name: '', callOwner: '', core: '' }, behavior: { proactivity: 'normal', text: '' }, style: { text: '', examples: [], banned: [] }, appearance: { text: '', referenceAssetIds: [] }, voice: { voice: '', speed: 1 }, policy: { mood: true, learnExpressions: true, useExpressions: true }, tags: [] })
    const scopeLabel = (s) => (s === 'global' ? '全局默认' : s === 'kind:group' ? '所有群默认' : s === 'kind:private' ? '所有私聊默认' : s.replace(/^chat:group:/, '群 ').replace(/^chat:private:/, '私聊 '))

    function PolishLayer({ section, text, onChoose, toast }) {
      const [candidate,setCandidate] = useState('')
      const [source,setSource] = useState('')
      return h('div',{className:'ab-grid',style:{gap:6,margin:'8px 0'}},
        h(Btn,{small:true,kind:'ghost',disabled:!String(text||'').trim(),onClick:async()=>{const original=String(text||'');const r=await post('/persona/polish',{text:original,section:section.split('.')[0]});if(r.ok===false || typeof r.text!=='string') return toast(r.message||'润色失败','err');setSource(original);setCandidate(r.text)}},'AI 润色此层'),
        candidate ? h('div',{className:'ab-grid ab-g2'},
          h('div',null,h('b',null,'当前文本'),h('pre',{className:'ab-pre'},source)),
          h('div',null,h('b',null,'建议文本'),h('pre',{className:'ab-pre'},candidate),h(Btn,{small:true,disabled:String(text||'')!==source,onClick:()=>{onChoose(candidate);setCandidate('')}},'采用到草稿'),h(Btn,{small:true,kind:'ghost',onClick:()=>setCandidate('')},'保留原文'),String(text||'')!==source?h('p',{className:'ab-note warn'},'原文已变化，请重新生成建议。'):null)) : null)
    }

    function PersonaRvc({ voice, onChange }) {
      const rvc = voice?.rvc || {}
      const change = (key, value) => {
        const next = { ...rvc }, updated = { ...(voice || {}) }
        if (value === undefined) delete next[key]; else next[key] = value
        if (Object.keys(next).length) updated.rvc = next; else delete updated.rvc
        onChange(updated)
      }
      return h('div', { className: 'ab-grid', style: { gap: 4, marginTop: 10 } },
        h('div', { className: 'ab-small ab-muted' }, '此人格的 RVC 覆盖（留空或选择跟随全局时继承语音设置；发布后生效）'),
        h(Row, { label: 'RVC 模式' }, h(Select, { value: rvc.enabled === true ? 'on' : rvc.enabled === false ? 'off' : '',
          options: [{value:'',label:'跟随全局'},{value:'on',label:'开启'},{value:'off',label:'关闭'}], onChange: v => change('enabled', v ? v === 'on' : undefined) })),
        h(Row, { label: 'RVC 音色' }, h('input', { className:'ab-input', value:rvc.voice ?? '', placeholder:'留空跟随全局', onChange:e => change('voice', e.target.value || undefined) })),
        h(Row, { label: 'RVC 音高' }, h('input', { className:'ab-input sm', type:'number', min:-24, max:24, value:rvc.pitch ?? '', placeholder:'跟随全局', onChange:e => change('pitch', e.target.value === '' ? undefined : Number(e.target.value)) })),
        h(Row, { label: '转换失败' }, h(Select, { value:rvc.fallback || '', options:[{value:'',label:'跟随全局'},{value:'original',label:'使用原声'},{value:'error',label:'报告失败'}], onChange:v => change('fallback',v || undefined) })),
        h(Row, { label: '转换超时（毫秒）' }, h('input', { className:'ab-input sm', type:'number', min:1000, max:300000, value:rvc.timeoutMs ?? '', placeholder:'跟随全局', onChange:e => change('timeoutMs', e.target.value === '' ? undefined : Number(e.target.value)) })))
    }

    function Persona({ st, toast, reload }) {
      const [list, setList] = useState(null)
      const [bindings, setBindings] = useState([])
      const [showArchived, setShowArchived] = useState(false)
      const [sel, setSel] = useState(st.config.persona.current)
      const [card, setCard] = useState(null) // 服务端的这张卡
      const [revs, setRevs] = useState([])
      const [form, setForm] = useState(null) // 编辑中的 { name, layers }
      const [dirty, setDirty] = useState(false)
      const [view, setView] = useState('edit') // edit / history / preview
      const [creating, setCreating] = useState(null) // { id, name }
      const loadSeq = useRef(0)
      const editSeq = useRef(0)
      const selectedRef = useRef(sel)
      selectedRef.current = sel

      const loadList = async () => {
        const r = await get('/persona/list')
        if (r.ok) { setList(r.list); setBindings(r.bindings) } else toast(r.message)
      }
      const loadCard = async (id) => {
        const seq = ++loadSeq.current // 切卡时丢掉迟到的加载结果
        const beforeEdit = editSeq.current
        const r = await get('/persona/full?id=' + encodeURIComponent(id))
        if (seq !== loadSeq.current) return
        if (!r.ok || !r.persona) { setCard(null); setForm(null); return }
        setCard(r.persona)
        setRevs(r.revisions || [])
        if (beforeEdit !== editSeq.current) return // 请求等待期间用户继续编辑，保留编辑框
        const layers = clone((r.persona.draft || r.persona.published || {}).layers || blankLayers())
        setForm({ name: r.persona.name, layers })
        setDirty(false)
      }
      useEffect(() => { loadList() }, [])
      useEffect(() => { if (sel) loadCard(sel) }, [sel])

      const pick = (id) => {
        if (id === sel) return
        if (dirty && !confirm('这张卡有没保存的改动，切走会丢掉。继续？')) return
        selectedRef.current = id
        editSeq.current++
        setView('edit')
        setSel(id)
      }
      const setL = (path, v) => { editSeq.current++; setForm({ ...form, layers: setPath(form.layers, path, v) }); setDirty(true) }
      const L = (path) => getPath(form.layers, path)
      const handle = async (r, okMsg, beforeEdit = editSeq.current, savedEdits = false) => {
        if (r.ok) {
          if (okMsg || r.message) toast(okMsg || r.message, 'ok')
          await loadList()
          if (r.persona && r.persona.id === selectedRef.current) {
            setCard(r.persona)
            if (beforeEdit === editSeq.current && (!dirty || savedEdits)) { setForm({ name: r.persona.name, layers: clone((r.persona.draft || r.persona.published).layers) }); setDirty(false) }
          }
          return true
        }
        if (r.code === 'STALE') toast('这张卡在别处改过了：点「重新载入」看最新的（你的改动还在编辑框里，可以先复制出来）', 'err')
        else toast(r.message || '没成功', 'err')
        return false
      }
      const saveDraft = async () => {
        const beforeEdit = editSeq.current
        return handle(await post('/persona/draft', { id: card.id, name: form.name, layers: form.layers, editRevision: card.editRevision }), '草稿存好了（还没生效，点「发布」才生效）', beforeEdit, true)
      }
      const publish = async () => {
        let c = card
        if (dirty) {
          const beforeEdit = editSeq.current
          const r = await post('/persona/draft', { id: card.id, name: form.name, layers: form.layers, editRevision: card.editRevision })
          if (!(await handle(r, '', beforeEdit, true))) return
          if (beforeEdit !== editSeq.current) { toast('保存期间又有编辑，已保留新改动；请检查后再发布', 'err'); return }
          c = r.persona
        }
        const beforeEdit = editSeq.current
        await handle(await post('/persona/publish', { id: c.id, editRevision: c.editRevision }), '发布了，下一轮回复起生效', beforeEdit, true)
        if (beforeEdit === editSeq.current) loadCard(c.id)
      }
      const used = (id) => bindings.filter((b) => b.personaId === id).map((b) => b.scope)

      const listView = list ? list.filter((p) => showArchived || !p.archived) : []
      const legacy = form && form.layers.legacy

      return h('div', { className: 'ab-persona' },
        h('div', { className: 'ab-plist' },
          list === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : listView.map((p) => h('button', { key: p.id, type: 'button', className: cx('ab-pitem', sel === p.id && 'on'), onClick: () => pick(p.id) },
            h('div', { className: 'nm' }, p.name,
              used(p.id).includes('global') ? h('span', { className: 'ab-badge' }, '全局默认') : used(p.id).length ? h('span', { className: 'ab-badge' }, '绑定 ' + used(p.id).length + ' 处') : null,
              p.hasDraft ? h('span', { className: 'ab-badge warn' }, '有草稿') : null,
              p.archived ? h('span', { className: 'ab-badge' }, '已归档') : null),
            h('div', { className: 'tg' }, (p.tags.length ? p.tags.join(' · ') + ' · ' : '') + (p.revision ? '第 ' + p.revision + ' 版' : '没发布过') + ' · ' + (ORIGIN[p.origin] || p.origin)))),
          creating ? h(Card, { title: '新建一张卡' },
            h(Row, { label: 'ID', hint: '英文字母、数字、- 和 _，以后不能改' }, h('input', { className: 'ab-input', value: creating.id, onChange: (e) => setCreating({ ...creating, id: e.target.value }) })),
            h(Row, { label: '名字' }, h('input', { className: 'ab-input', value: creating.name, onChange: (e) => setCreating({ ...creating, name: e.target.value }) })),
            h('div', { className: 'ab-flex' }, h('div', { className: 'ab-spacer' }),
              h(Btn, { small: true, kind: 'ghost', onClick: () => setCreating(null) }, '取消'),
              h(Btn, { small: true, kind: 'primary', onClick: async () => {
                const layers = blankLayers()
                layers.identity.name = creating.name
                const r = await post('/persona/create', { id: creating.id, name: creating.name, layers })
                if (await handle(r, '建好了，填好内容再发布')) { setCreating(null); if (dirty) toast('新卡已建立，当前未保存的编辑已保留'); else setSel(creating.id) }
              } }, '新建'))) : h('div', { className: 'ab-flex' },
            h(Btn, { kind: 'ghost', onClick: () => setCreating({ id: 'persona-' + Date.now().toString(36), name: '新人设' }) }, '＋ 新建'),
            h(ImportPersona, { toast, onDone: async (id) => { await loadList(); if (dirty) toast('导入完成，当前未保存的编辑已保留'); else setSel(id) } })),
          h('label', { className: 'ab-small ab-muted', style: { display: 'block', marginTop: 6 } }, h('input', { type: 'checkbox', checked: showArchived, onChange: (e) => setShowArchived(e.target.checked) }), ' 显示已归档的卡'),
          h(PersonaBindings, { st, list: list || [], bindings, toast, onChange: (b) => { setBindings(b); reload() } }),
          h(AvatarCard, { st, toast, reload }),
        ),
        !card || !form ? h(Card, null, h(Empty, { icon: list && !list.length ? '🃏' : '⏳', text: list && !list.length ? '还没有人设卡' : '加载中…' })) : h(Card, {
          title: form.name || card.id,
          desc: (card.published ? '线上是第 ' + card.published.revision + ' 版' : '还没发布过') + (card.draft ? '，有没发布的草稿' : '') + (dirty ? '，编辑框里有没保存的改动' : '') + '。改动先存成草稿，点「发布」后从下一轮回复起生效；发布过的版本不会被改，可以随时回滚。',
          right: h(Seg, { value: view, onChange: setView, options: [{ value: 'edit', label: '编辑' }, { value: 'preview', label: '预览' }, { value: 'history', label: '历史 ' + revs.length }] }),
        },
        card.archivedAt ? h('div', { className: 'ab-note' }, '这张卡已归档，不能改也不能绑定。', h(Btn, { small: true, onClick: async () => handle(await post('/persona/unarchive', { id: card.id }), '取消归档了') }, '取消归档'), ' ',
          h(Btn, { small: true, kind: 'danger', onClick: async () => { if (!confirm('彻底删除这张卡和它的所有版本？删除后不能恢复。')) return; const r = await post('/persona/remove', { id: card.id }); if (r.ok) { toast('删掉了'); setSel(st.config.persona.current); loadList() } else toast(r.message, 'err') } }, '彻底删除')) : null,
        view === 'edit' ? h('div', null,
          h(Row, { label: '卡片名字' }, h('input', { className: 'ab-input', value: form.name, onChange: (e) => { editSeq.current++; setForm({ ...form, name: e.target.value }); setDirty(true) } })),
          h(Row, { label: '标签', hint: '逗号隔开，只用来分类' }, h(ListArea, { value: L('tags') || [], onChange: (v) => setL('tags', v), placeholder: '甜美，粘人' })),
          legacy ? h('div', { className: 'ab-psec' },
            h('h4', null, '旧版原文'),
            h('p', { className: 'ab-desc' }, '这张卡是从旧版人格原样导入的：整篇正文就是全部设定。下面的分层内容（如果填了）会补在原文后面。'),
            h('textarea', { className: 'ab-textarea', style: { minHeight: 260 }, value: legacy.body, onChange: (e) => setL('legacy.body', e.target.value) }),
            h('div', { className: 'ab-muted ab-small' }, legacy.body.length + ' 字')) : null,
          h('div', { className: 'ab-psec', style: { borderLeft: '3px solid #4978bc', paddingLeft: 12 } },
            h('h4', null, '她是谁'),
            h(Row, { label: '名字', hint: '她怎么称呼自己' }, h('input', { className: 'ab-input', value: L('identity.name') || '', onChange: (e) => setL('identity.name', e.target.value) })),
            h(Row, { label: '怎么叫主人', hint: '留空就用「权限」页里的称呼' }, h('input', { className: 'ab-input', value: L('identity.callOwner') || '', onChange: (e) => setL('identity.callOwner', e.target.value) })),
            h('textarea', { className: 'ab-textarea', style: { minHeight: 110 }, placeholder: '身份、关系、稳定的性格……', value: L('identity.core') || '', onChange: (e) => setL('identity.core', e.target.value) }), h(PolishLayer, { section: 'identity.core', text: L('identity.core') || '', onChoose: v => setL('identity.core', v), toast })),
          h('div', { className: 'ab-psec', style: { borderLeft: '3px solid #469782', paddingLeft: 12 } },
            h('h4', null, '平时怎么做'),
            h(Row, { label: '主动程度', hint: '仍然受「聊天」页的频率限制' }, h(Seg, { value: L('behavior.proactivity'), options: PROACTIVITY, onChange: (v) => setL('behavior.proactivity', v) })),
            h('textarea', { className: 'ab-textarea', style: { minHeight: 80 }, placeholder: '群里什么时候接话、什么时候追问……', value: L('behavior.text') || '', onChange: (e) => setL('behavior.text', e.target.value) }), h(PolishLayer, { section: 'behavior.text', text: L('behavior.text') || '', onChoose: v => setL('behavior.text', v), toast })),
          h('div', { className: 'ab-psec', style: { borderLeft: '3px solid #bd8250', paddingLeft: 12 } },
            h('h4', null, '说话方式'),
            h('textarea', { className: 'ab-textarea', style: { minHeight: 80 }, placeholder: '用词、句子长短、口头禅……', value: L('style.text') || '', onChange: (e) => setL('style.text', e.target.value) }),
            h(PolishLayer, { section: 'style.text', text: L('style.text') || '', onChoose: v => setL('style.text', v), toast }),
            h(Row, { label: '示例', hint: '一行一句她会说的话' }, h(ListArea, { value: L('style.examples') || [], onChange: (v) => setL('style.examples', v), placeholder: '哼 谁要你夸' })),
            h(Row, { label: '别说的话', hint: '一行一个' }, h(ListArea, { value: L('style.banned') || [], onChange: (v) => setL('style.banned', v), placeholder: '综上所述' }))),
          h('div', { className: 'ab-psec', style: { borderLeft: '3px solid #a57bb6', paddingLeft: 12 } },
            h('h4', null, '样子与声音'),
            h('textarea', { className: 'ab-textarea', style: { minHeight: 70 }, placeholder: '外观描述（画她自己时也会用到）', value: L('appearance.text') || '', onChange: (e) => setL('appearance.text', e.target.value) }),
            h(PolishLayer, { section: 'appearance.text', text: L('appearance.text') || '', onChoose: v => setL('appearance.text', v), toast }),
            h(Row, { label: '音色', hint: '留空用「语音」页的默认音色' }, h('input', { className: 'ab-input', value: L('voice.voice') || '', onChange: (e) => setL('voice.voice', e.target.value) })),
            h(Row, { label: '语速' }, h(Range, { min: 0.5, max: 2, step: 0.1, value: L('voice.speed') || 1, onChange: (v) => setL('voice.speed', v), fmt: (v) => Number(v).toFixed(1) + '×' })),
            h(PersonaRvc, { voice: L('voice'), onChange: v => setL('voice', v) })),
          h('div', { className: 'ab-psec', style: { borderLeft: '3px solid #bb7182', paddingLeft: 12 } },
            h('h4', null, '情绪与学习'),
            h(Row, { label: '有心情起伏' }, h(Switch, { on: L('policy.mood') !== false, onChange: (v) => setL('policy.mood', v) })),
            h(Row, { label: '学群友的说话方式', hint: '只学，不一定用' }, h(Switch, { on: L('policy.learnExpressions') !== false, onChange: (v) => setL('policy.learnExpressions', v) })),
            h(Row, { label: '用学到的说话方式' }, h(Switch, { on: L('policy.useExpressions') !== false, onChange: (v) => setL('policy.useExpressions', v) }))),
          h('div', { className: 'ab-flex', style: { marginTop: 12, flexWrap: 'wrap' } },
            h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (dirty && !confirm('丢掉编辑框里没保存的改动？')) return; loadCard(card.id) } }, '重新载入'),
            card.draft && card.published ? h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('丢掉草稿，回到线上的第 ' + card.published.revision + ' 版？')) return; handle(await post('/persona/discard', { id: card.id, editRevision: card.editRevision }), '草稿丢掉了') } }, '丢弃草稿') : null,
            h(Btn, { small: true, kind: 'ghost', onClick: async () => { const nid = card.id + '-copy'; const r = await post('/persona/duplicate', { id: card.id, newId: nid }); if (await handle(r, '复制了一张')) { if (dirty) toast('复制完成，当前未保存的编辑已保留'); else setSel(nid) } } }, '复制一张'),
            h(Btn, { small: true, kind: 'ghost', onClick: async () => { const r = await get('/persona/export?id=' + encodeURIComponent(card.id)); if (!r.ok) return toast(r.message, 'err'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r.card, null, 2)], { type: 'application/json' })); a.download = card.id + '.persona.json'; a.click() } }, '导出'),
            !card.archivedAt ? h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('归档这张卡？归档后不能改也不能绑定，随时可以取消归档。')) return; const r = await post('/persona/archive', { id: card.id, editRevision: card.editRevision }); if (r.code === 'IN_USE') toast('还绑定在：' + r.scopes.map(scopeLabel).join('、') + '。先在左边「绑定」里换成别的卡', 'err'); else handle(r, '归档了') } }, '归档') : null,
            h('div', { className: 'ab-spacer' }),
            h(Btn, { kind: 'ghost', disabled: !dirty || !!card.archivedAt, onClick: saveDraft }, '存草稿'),
            h(Btn, { kind: 'primary', disabled: (!dirty && !card.draft) || !!card.archivedAt, onClick: publish }, '发布'))) : null,
        view === 'preview' ? h(PersonaPreview, { layers: form.layers, published: card.published }) : null,
        view === 'history' ? h('div', { className: 'ab-list' }, revs.length ? null : h(Empty, { text: '还没发布过' }), revs.map((r) => h(PersonaRevision, { key: r.revision, id: card.id, rev: r, current: card.published && card.published.revision === r.revision, onRollback: async () => {
          if (dirty && !confirm('编辑框里没保存的改动会丢掉，继续回滚？')) return
          if (!confirm('把第 ' + r.revision + ' 版的内容发布成新的一版？')) return
          handle(await post('/persona/rollback', { id: card.id, revision: r.revision, editRevision: card.editRevision }), '回滚好了（发布成了新的一版）').then(() => loadCard(card.id))
        } }))) : null,
        ),
        h(EffectivePrompt, { st, bindings, personaVersions: (list || []).map(p => [p.id, p.revision]) }),
      )
    }

    /** 某个聊天实际会用的提示词：哪张卡哪个版本（从哪层绑定来的）、运行规则、模型。 */
    function EffectivePrompt({ st, bindings, personaVersions }) {
      const chats = Array.from(new Set([...Object.keys(st.sessions || {}).filter((k) => !k.startsWith('system:')), ...(st.config.allow.groups || []).map((g) => 'group:' + g), 'private:' + st.config.ownerQQ, ...(st.config.allow.private || []).map((q) => 'private:' + q)])).filter((c) => /^(group|private):\d+$/.test(c))
      const [chat, setChat] = useState(chats[0] || '')
      const [p, setP] = useState(null)
      const [open, setOpen] = useState('')
      useEffect(() => {
        let active = true
        if (chat) get('/prompt/preview?chatId=' + encodeURIComponent(chat)).then(value => { if (active) setP(value) })
        return () => { active = false }
      }, [chat, JSON.stringify(bindings), JSON.stringify(personaVersions), JSON.stringify(st.config)])
      const label = (c) => (c === 'private:' + st.config.ownerQQ ? '主人私聊' : c.replace('group:', '群 ').replace('private:', '私聊 '))
      return h(Card, { className: 'ab-span', title: '某个聊天实际用的提示词', desc: '按现在的绑定和设置，这个聊天下一轮会拿到的人设和规则。改了卡或绑定后这里跟着变。',
        right: h(Select, { value: chat, width: 180, options: chats.map((c) => ({ value: c, label: label(c), desc: c })), onChange: setChat }) },
        !p ? h(Empty, { icon: '⏳', text: '加载中…' }) : !p.ok ? h('div', { className: 'ab-note err' }, p.message) : h('div', null,
          h('div', { className: 'ab-kv' },
            h('span', null, '人设'), h('span', null, p.persona.error ? h('b', { style: { color: 'var(--ab-err)' } }, p.persona.error) : p.persona.name + '（' + p.persona.id + '）第 ' + p.persona.revision + ' 版 · 来自「' + scopeLabel(p.persona.scope) + '」'),
            h('span', null, '规则'), h('span', null, p.rulesKind === 'private' ? '主人私聊（完整权限）' : '群聊 / 其他人（只有 QQ 工具）'),
            h('span', null, '模型'), h('span', null, p.model ? p.model.provider + ' / ' + p.model.model + (p.model.reasoningEffort ? ' · 思考 ' + p.model.reasoningEffort : '') : '跟随 DSH 默认'),
            h('span', null, '工具上限'), h('span', null, '每轮 ' + p.toolCallsPerTurn + ' 次')),
          h('div', { className: 'ab-flex', style: { marginTop: 10 } },
            h(Btn, { small: true, kind: open === 'persona' ? 'primary' : 'ghost', onClick: () => setOpen(open === 'persona' ? '' : 'persona') }, '人设正文 ' + p.personaText.length + ' 字'),
            h(Btn, { small: true, kind: open === 'rules' ? 'primary' : 'ghost', onClick: () => setOpen(open === 'rules' ? '' : 'rules') }, '运行规则 ' + p.rules.length + ' 字')),
          open ? h('pre', { className: 'ab-pre', style: { marginTop: 8 } }, open === 'persona' ? p.personaText : p.rules) : null))
    }

    /** 预览：这张卡实际交给模型的正文（草稿 / 线上）。 */
    function PersonaPreview({ layers, published }) {
      const [a, setA] = useState('')
      const [b, setB] = useState('')
      useEffect(() => { post('/persona/preview', { layers }).then((r) => setA(r.text || '')) }, [JSON.stringify(layers)])
      useEffect(() => { if (published) post('/persona/preview', { layers: published.layers }).then((r) => setB(r.text || '')) }, [published && published.revision])
      return h('div', { className: 'ab-grid ab-g2' },
        h('div', null, h('h4', null, '编辑框里的'), h('pre', { className: 'ab-pre' }, a || '（空）')),
        h('div', null, h('h4', null, published ? '线上第 ' + published.revision + ' 版' : '线上（还没发布）'), h('pre', { className: 'ab-pre' }, published ? b : '—')))
    }

    function PersonaRevision({ id, rev, current, onRollback }) {
      const [open, setOpen] = useState(false)
      const [text, setText] = useState('')
      const toggle = async () => {
        if (!open && !text) {
          const r = await get('/persona/revision?id=' + encodeURIComponent(id) + '&revision=' + rev.revision)
          const p = r.ok && r.revision ? await post('/persona/preview', { layers: r.revision.layers }) : { text: '' }
          setText(p.text || '')
        }
        setOpen(!open)
      }
      return h('div', { className: 'ab-li', style: { display: 'block' } },
        h('div', { className: 'ab-flex' },
          h('b', null, '第 ' + rev.revision + ' 版'), current ? h('span', { className: 'ab-badge' }, '线上') : null,
          h('span', { className: 'ab-muted ab-small' }, new Date(rev.createdAt).toLocaleString() + (rev.note ? ' · ' + rev.note : '')),
          h('div', { className: 'ab-spacer' }),
          h(Btn, { small: true, kind: 'ghost', onClick: toggle }, open ? '收起' : '查看'),
          !current ? h(Btn, { small: true, onClick: onRollback }, '回滚到这一版') : null),
        open ? h('pre', { className: 'ab-pre', style: { marginTop: 8 } }, text || '（空）') : null)
    }

    /** 绑定：全局 / 所有群 / 所有私聊的默认，以及单个聊天。 */
    function PersonaBindings({ st, list, bindings, toast, onChange }) {
      const [chat, setChat] = useState('')
      const [pid, setPid] = useState('')
      const usable = list.filter((p) => !p.archived && p.revision > 0).map((p) => ({ value: p.id, label: p.name, desc: p.id }))
      const of = (scope) => (bindings.find((b) => b.scope === scope) || {}).personaId || ''
      const bind = async (scope, personaId) => {
        const r = await post('/persona/bind', { scope, personaId })
        if (r.ok) { onChange(r.bindings); toast(r.message, 'ok') } else toast(r.message, 'err')
      }
      const knownChats = Array.from(new Set([...Object.keys(st.sessions || {}).filter((k) => !k.startsWith('system:')), ...(st.config.allow.groups || []).map((g) => 'group:' + g), ...(st.config.allow.private || []).map((q) => 'private:' + q)]))
      const perChat = bindings.filter((b) => b.scope.startsWith('chat:'))
      return h(Card, { title: '绑定', desc: '每个聊天按「单个聊天 → 所有群 / 所有私聊默认 → 全局默认」找用哪张卡。换成另一张卡的聊天会开一个新会话，旧角色没说完的话不会带过来。' },
        h('div', { className: 'ab-brow' }, h('span', null, '全局默认'), h(Select, { value: of('global'), options: usable, width: 150, onChange: (v) => bind('global', v) })),
        h('div', { className: 'ab-brow' }, h('span', null, '所有群'), h(Select, { value: of('kind:group'), options: [{ value: '', label: '跟全局' }, ...usable], width: 150, onChange: (v) => bind('kind:group', v || null) })),
        h('div', { className: 'ab-brow' }, h('span', null, '所有私聊'), h(Select, { value: of('kind:private'), options: [{ value: '', label: '跟全局' }, ...usable], width: 150, onChange: (v) => bind('kind:private', v || null) })),
        perChat.map((b) => h('div', { key: b.scope, className: 'ab-brow' }, h('span', null, scopeLabel(b.scope)),
          h('div', { className: 'ab-flex' }, h(Select, { value: b.personaId, options: usable, width: 110, onChange: (v) => bind(b.scope, v) }),
          h(Btn, { small: true, kind: 'ghost', onClick: () => bind(b.scope, null) }, '去掉')))),
        h('div', { className: 'ab-flex', style: { marginTop: 10, flexWrap: 'wrap' } },
          h(Select, { value: chat, placeholder: '选一个聊天', width: 120, options: knownChats.filter((c) => !perChat.some((b) => b.scope === 'chat:' + c)).map((c) => ({ value: c, label: c.replace('group:', '群 ').replace('private:', '私聊 ') })), onChange: setChat }),
          h(Select, { value: pid, placeholder: '用哪张卡', width: 100, options: usable, onChange: setPid }),
          h(Btn, { small: true, disabled: !chat || !pid, onClick: async () => { await bind('chat:' + chat, pid); setChat(''); setPid('') } }, '单独绑定')))
    }

    function ImportPersona({ toast, onDone }) {
      const ref = useRef(null)
      return h(Fragment, null,
        h(Btn, { kind: 'ghost', onClick: () => ref.current && ref.current.click() }, '导入'),
        h('input', { ref, type: 'file', accept: '.json,application/json', style: { display: 'none' }, onChange: async (e) => {
          const file = e.target.files && e.target.files[0]
          e.target.value = ''
          if (!file) return
          let card
          try { card = JSON.parse(await file.text()) } catch (err) { return toast('不是合法的 JSON 文件', 'err') }
          let r = await post('/persona/import', { card })
          if (r.code === 'EXISTS') {
            const id = (card.id || 'persona') + '-' + Date.now().toString(36).slice(-4)
            if (!confirm('已经有同 ID 的卡了，导入成「' + id + '」？')) return
            r = await post('/persona/import', { card, id })
          }
          if (r.ok) { toast('导入了（还没绑定，确认内容后在左边绑定）', 'ok'); onDone(r.persona.id) } else toast(r.message, 'err')
        } }))
    }


    function Access({ draft, setDraft }) {
      const f = useField(draft, setDraft)
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '主人', desc: '主人的 QQ 号。群管、点歌、电脑上的操作只听主人的。' },
          h(Row, { label: '主人 QQ 号' }, f.text('ownerQQ')),
          h(Row, { label: '她怎么称呼你' }, f.text('ownerName', { placeholder: '主人' })),
          h(Row, { label: '主人私聊的权限', hint: '群聊永远没有电脑操作权限，这里管不到群。' },
            h('div', { style: { width: '100%' } },
              h(Choices, { value: draft.ownerLevel, onChange: (v) => setDraft(setPath(draft, 'ownerLevel', v)), options: [
                { value: 'full', label: '完整', desc: '私聊里让她用电脑做事（查文件、跑命令、上网查）也能做' },
                { value: 'social', label: '受限', desc: '只有发表情、翻聊天记录这类 QQ 工具，碰不到电脑' },
                { value: 'chat', label: '纯聊天', desc: '什么工具都没有，只聊天' },
              ] }),
              h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '切换后会给主人私聊换一个新的 DSH 会话（旧的还在侧栏里）。'))),
          h(Row, { label: '长任务模式', hint: '只在「完整」权限下生效。打开后她能把命令放到后台跑、跑完自动回来告诉你，也能设定时任务；工具多一点，回话会稍慢。切换后同样换新会话。' },
            h(Choices, { value: draft.longTasks ? 'on' : 'off', onChange: (v) => setDraft(setPath(draft, 'longTasks', v === 'on')), options: [
              { value: 'off', label: '关', desc: '维持现在的速度（默认）' },
              { value: 'on', label: '开', desc: '挂上后台任务（jobs）+ 定时任务（schedule）' },
            ] })),
        ),
        h(ProfilePerms, { draft, setDraft }),
        h(Card, { title: '白名单', desc: '只有名单里的人和群，她才会理。一行一个号码。' },
          h(Row, { label: '私聊白名单', hint: '主人默认就在里面。' }, f.list('allow.private', { placeholder: '每行一个 QQ 号', numbers: true })),
          h(Row, { label: '群白名单', hint: '把机器人拉进群后，把群号加到这里。' }, f.list('allow.groups', { placeholder: '每行一个群号', numbers: true })),
        ),
        h(GroupRoles, null),
        h(CommandList, null),
      )
    }

    /** 改资料类操作的权限：关 / 仅主人私聊 / 所有人。 */
    function ProfilePerms({ draft, setDraft }) {
      const perms = draft.profilePerms || {}
      const opts = [
        { value: 'off', label: '关', desc: '谁说都不改' },
        { value: 'owner', label: '仅主人私聊', desc: '只有你私聊让她改才改（默认）' },
        { value: 'all', label: '所有人', desc: '白名单里的人、群里的人都能让她改' },
      ]
      const row = (key, label, hint) => h(Row, { label, hint },
        h(Choices, { value: perms[key] || 'owner', onChange: (v) => setDraft(setPath(draft, 'profilePerms.' + key, v)), options: opts }))
      return h(Card, { title: '改资料与名单', desc: '她能不能听人的话改自己的 QQ 昵称、签名、头像和 B 站签名，处理好友申请、改白名单。改 QQ 资料要 SnowLuma 支持（set_qq_profile / set_self_longnick / set_qq_avatar）。' },
        row('qqNickname', 'QQ 昵称'),
        row('qqSignature', 'QQ 个性签名'),
        row('qqAvatar', 'QQ 头像', '只用网址图片，或「刚才发的那张图」。'),
        row('biliSign', 'B 站签名', '要先在 B 站页登录并打开 B 站。'),
        row('biliAvatar', 'B 站头像', '要先在 B 站页登录并打开 B 站。图片网址或刚才发的图，最大 2MB。'),
        row('qqFriendRequest', '处理好友申请', '让她通过 / 拒绝别人加她为好友的申请。她自己主动加别人暂不支持（SnowLuma 没有这个接口）。'),
        row('whitelist', '改白名单', '让她把 QQ 号 / 群号加进或移出下面的白名单。主人不会被移出。开成「所有人」前请想清楚。'),
      )
    }

    /** QQ 里的主人命令一览。 */
    function CommandList() {
      const [list, setList] = useState([])
      useEffect(() => { get('/commands').then((r) => setList(r.list || [])) }, [])
      return h(Card, { title: 'QQ 命令', desc: '主人在 QQ 里（私聊或白名单群）直接发这些命令就能管她，别人发了不算。总开关关着时也能用。' },
        h('table', { className: 'ab-table' }, h('tbody', null, list.map((c) => h('tr', { key: c.name },
          h('td', { style: { whiteSpace: 'nowrap' } }, h('code', null, '/' + c.name), c.aliases.length ? h('div', { className: 'ab-muted ab-small' }, c.aliases.map((a) => '/' + a).join(' ')) : null),
          h('td', null, c.desc))))))
    }

    /** 她在每个白名单群里的身份：群主 / 管理员才能禁言踢人。 */
    function GroupRoles() {
      const [list, setList] = useState(null)
      const load = () => { setList(null); get('/groups/roles').then((r) => setList(r.list || [])) }
      useEffect(load, [])
      return h(Card, { title: '群管权限', desc: '她在群里是群主或管理员时，主人才能让她禁言、踢人、发公告；改专属头衔要群主。按已保存的群白名单查。',
        right: h(Btn, { small: true, kind: 'ghost', onClick: load }, '刷新') },
        !list ? h('div', { className: 'ab-muted ab-small' }, h('i', { className: 'ab-spin' }), ' 查询中…')
          : list.length === 0 ? h('div', { className: 'ab-muted ab-small' }, '群白名单是空的。')
          : h('table', { className: 'ab-table' },
            h('thead', null, h('tr', null, ['群', '她的身份', '群管'].map((x) => h('th', { key: x }, x)))),
            h('tbody', null, list.map((g) => h('tr', { key: g.groupId },
              h('td', null, (g.name && g.name !== g.groupId ? g.name + ' ' : '') + '(' + g.groupId + ')'),
              h('td', null, g.label),
              h('td', null, g.canManage ? h('span', { className: 'ab-badge' }, '可以') : h('span', { className: 'ab-muted ab-small' }, '不行')))))))
    }

    function Group({ draft, setDraft }) {
      const f = useField(draft, setDraft)
      const overrides = draft.group.overrides || {}
      const [newGid, setNewGid] = useState('')
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '危险命令确认', right: f.sw('security.dangerConfirm'), desc: '打开后，主人私聊里她要执行删根目录、格式化、关机、下载后直接执行这类终端命令时，会先在 QQ 问你，回复「确认」才执行，60 秒没回就拦下。只检查 bash / pwsh 的命令原文，挡不住编码或脚本文件绕过，不能当沙箱用。' }),
        h(Card, { title: '发文件', right: f.sw('files.enabled'), desc: '打开后，主人私聊里可以让她把本机文件发到当前聊天或白名单里的人和群。默认只能发 QQ 工作区里的文件；含密钥的文件（.env、.ssh、私钥等）一律不发。' },
          h(Row, { label: '单个文件上限' }, f.num('files.maxMB', { min: 1, max: 2048 }), h('span', { className: 'ab-muted ab-small' }, ' MB')),
          h(Row, { label: '额外允许的目录', hint: '绝对路径，一行一个。' }, f.list('files.dirs', { placeholder: 'D:\\共享文件' }))),
        h(Card, { title: '连发合并', right: f.sw('merge.enabled'), desc: '人常常一口气发好几句。打开后她会等对方说完再一起回，而不是一句一回。' },
          h(Row, { label: '对方停顿多久算说完' }, f.range('merge.waitSec', 0.5, 10, 0.5, (v) => v + ' 秒')),
          h(Row, { label: '最多等多久', hint: '对方一直在发也最多等这么久' }, f.range('merge.maxSec', 2, 30, 1, (v) => v + ' 秒')),
          h(Row, { label: '群里停顿多久算一段', hint: '群里大家你一句我一句，多等一会儿把一段话攒齐再回；她回上一段的时候，新消息也会先攒着' }, f.range('merge.groupWaitSec', 1, 20, 1, (v) => v + ' 秒')),
          h(Row, { label: '群里最多等多久' }, f.range('merge.groupMaxSec', 3, 60, 1, (v) => v + ' 秒')),
        ),
        h(Card, { title: '群里什么时候必回', desc: '被 @、有人引用回复她的消息、或者提到下面这些名字时，她一定会回。' },
          h(Row, { label: '唤醒词', hint: '一行一个' }, f.list('group.wakeWords', { placeholder: '大肥鱼\n肥鱼' })),
          h(Row, { label: '连续任务衔接', hint: '被叫到后，同一人补图片、引用、追问或纠错，在这段时间内作为当前求助处理。普通闲聊和纯表情仍走插话策略。' }, f.num('conversation.followupSeconds', { min: 15, max: 180 }), ' 秒'),
        ),
        h(Card, { title: '会话历史窗口', desc: '达到任一上限后，从下一轮启用新的短会话；已保存的聊天和记忆仍可查询。减少旧话题干扰和长上下文等待。' },
          h(Row, { label: '最多保留轮数' }, f.num('conversation.maxTurns', { min: 8, max: 200 })),
          h(Row, { label: '上下文 token 上限' }, f.num('conversation.maxContextTokens', { min: 8000, max: 200000, step: 1000 })),
          h(Row, { label: '最长会话时长' }, f.num('conversation.maxAgeMinutes', { min: 30, max: 1440 }), ' 分钟')),
        h(Card, { title: '自动参与刹车', desc: '群里短时间说太多就暂停自动接话；有效的 @、引用回复和唤醒词仍会单独处理。' },
          h(Row, { label: '最多说几次' }, f.range('group.burstMax', 1, 20, 1, (v) => v + ' 次'), h('span', { className: 'ab-muted' }, '/'), f.range('group.burstWindowSec', 30, 600, 30, (v) => Math.round(v / 6) / 10 + ' 分钟')),
        ),
        h(Card, { title: '群里插话', desc: '没人叫她的时候，她也可能自然地插一句；她看完群里在聊什么，也可以决定不说话。' },
          h(Row, { label: '基础插话概率', hint: '每批合并后的普通消息判断一次，并根据话题和近期发言情况调整' }, f.percent('group.interjectChance')),
          h(Row, { label: '冷却', hint: '两次插话至少隔多久' }, f.range('group.cooldownSec', 0, 600, 10, (v) => v + ' 秒')),
          h(Row, { label: '每小时最多插话' }, f.range('group.maxPerHour', 0, 30, 1, (v) => v + ' 次')),
          h(Row, { label: '她感兴趣的话题', hint: '群里在聊这些（或她记得相关的事）时更容易插话；一行一个' }, f.list('group.interests', { placeholder: '白米饭\n游戏\n追剧' })),
          h(Row, { label: '话题相关度门槛', hint: '和她关系不大的话题就不插话；拉到 0 = 不看话题、纯随机' }, f.range('group.minRelevance', 0, 1, 0.05, (v) => (v === 0 ? '不看话题' : Math.round(v * 100) + '%'))),
          h('div', { className: 'ab-note', style: { marginTop: 8 } }, '加入话题后会更愿意接话；自动接话仍受冷却、每小时上限和退避控制。只有获得发送回执的回复才计入成功发言量。'),
          h(Row, { label: '群冷清时不插话', hint: '最近几分钟内消息少于这个数就不插' }, f.num('group.minRecentMessages', { min: 0 }), h('span', { className: 'ab-muted' }, '条 / '), f.num('group.activeWindowSec', { min: 30 }), h('span', { className: 'ab-muted' }, '秒')),
          h(Row, { label: '静默时段', hint: '这段时间不插话（被叫到还是会回）' },
            h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 23, value: draft.group.quietHours[0], onChange: (e) => setDraft(setPath(draft, 'group.quietHours', [Number(e.target.value), draft.group.quietHours[1]])) }),
            h('span', { className: 'ab-muted' }, '点 到'),
            h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 23, value: draft.group.quietHours[1], onChange: (e) => setDraft(setPath(draft, 'group.quietHours', [draft.group.quietHours[0], Number(e.target.value)])) }),
            h('span', { className: 'ab-muted' }, '点')),
        ),
        h(Card, { title: '动态频率与空闲退避', right: f.sw('participation.enabled'), desc: '连续决定不参与时延长检查间隔；积压消息多、近期回复超过预计量时降低自动插话概率。明确请求和任务完成不受空闲退避阻挡。' },
          h(Row, { label: '首次退避' }, f.num('participation.idleBaseMs', { min: 0, step: 1000 }), h('span', { className: 'ab-muted' }, '毫秒')),
          h(Row, { label: '最长退避' }, f.num('participation.idleMaxMs', { min: 0, step: 1000 }), h('span', { className: 'ab-muted' }, '毫秒')),
          h(Row, { label: '退避倍率' }, f.range('participation.idleFactor', 1, 8, 0.5, v => v + ' 倍')),
          h(Row, { label: '发言反馈强度' }, f.range('participation.feedbackGain', 0, 10, 0.5)),
          h(Row, { label: '积压收紧强度' }, f.range('participation.burstGain', 0, 10, 0.5)),
          h(Row, { label: '每份预计批次消息数', hint: '用于估计积压参与量，不改变实际消息合并窗口' }, f.num('participation.messagesPerVirtualBatch', { min: 1, max: 1000 })),
        ),
        h(Card, { title: '按群单独设置', desc: '某个群想让她更安静或更活跃，在这里单独设插话概率。' },
          Object.keys(overrides).length === 0 ? h('div', { className: 'ab-muted', style: { marginBottom: 10 } }, '还没有单独设置的群。') :
            Object.entries(overrides).map(([gid, o]) => h(Row, { key: gid, label: '群 ' + gid },
              h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 100, value: pct(o.interjectChance ?? draft.group.interjectChance), onChange: (e) => setDraft(setPath(draft, 'group.overrides', { ...overrides, [gid]: { ...o, interjectChance: Number(e.target.value) / 100 } })) }),
              h('span', { className: 'ab-muted' }, '% 插话'),
              h(Btn, { small: true, kind: 'ghost', onClick: () => { const n = { ...overrides }; delete n[gid]; setDraft(setPath(draft, 'group.overrides', n)) } }, '移除'))),
          h('div', { className: 'ab-flex' }, h('input', { className: 'ab-input', placeholder: '群号', value: newGid, onChange: (e) => setNewGid(e.target.value.replace(/\D/g, '')) }),
            h(Btn, { small: true, disabled: !newGid, onClick: () => { setDraft(setPath(draft, 'group.overrides', { ...overrides, [newGid]: { interjectChance: draft.group.interjectChance } })); setNewGid('') } }, '添加')),
        ),
      )
    }

    /** 按聊天选模型：私聊默认 / 群聊默认两个下拉，单个 QQ / 群的例外放在默认收起的小列表里。 */
    function ChatModels({ draft, setDraft, list }) {
      const cm = draft.chatModels || { privateDefault: {}, groupDefault: {}, privates: {}, groups: {} }
      const [open, setOpen] = useState(false)
      const [add, setAdd] = useState({ kind: 'private', id: '', sel: '' })
      const key = (m) => m.provider + '::' + m.model
      const val = (s) => (s && s.provider && s.model ? s.provider + '::' + s.model : '')
      const toSel = (v) => { const [p, ...m] = v.split('::'); return v ? { provider: p, model: m.join('::'), reasoningEffort: '' } : { provider: '', model: '', reasoningEffort: '' } }
      const base = [{ value: '', label: '跟随全局模型', desc: '上面「聊天用的模型」' }].concat((list || []).map((m) => ({ value: key(m), label: m.name, desc: m.provider, group: m.provider })))
      const optsFor = (v) => (v && !base.some((o) => o.value === v) ? base.concat([{ value: v, label: v.split('::').slice(1).join('::'), desc: '（DSH 里没找到）' }]) : base)
      const setCm = (patch) => setDraft(setPath(draft, 'chatModels', { ...cm, ...patch }))
      const rows = [['private', cm.privates || {}], ['group', cm.groups || {}]].flatMap(([kind, m]) => Object.entries(m).map(([id, sel]) => ({ kind, id, sel })))
      const label = (sel) => { const v = val(sel); const hit = (list || []).find((m) => key(m) === v); return hit ? hit.name : sel.model }
      const addRow = () => {
        if (!add.id || !add.sel) return
        const field = add.kind === 'private' ? 'privates' : 'groups'
        setCm({ [field]: { ...(cm[field] || {}), [add.id]: toSel(add.sel) } })
        setAdd({ ...add, id: '' })
      }
      const remove = (kind, id) => { const field = kind === 'private' ? 'privates' : 'groups'; const n = { ...(cm[field] || {}) }; delete n[id]; setCm({ [field]: n }) }
      return h(Card, { title: '按聊天选模型', desc: '顺序：这个私聊 > 这个群 > 所有私聊 / 所有群的默认 > 上面的全局模型。没选的一级就用下一级；选的模型在 DSH 里找不到时也自动退回。只有你能在这里改，聊天里的人换不了。换了之后从那个聊天的下一条消息起生效。' },
        h(Row, { label: '私聊默认模型' }, h(Select, { value: val(cm.privateDefault), width: 280, options: optsFor(val(cm.privateDefault)), onChange: (v) => setCm({ privateDefault: toSel(v) }) })),
        h(Row, { label: '群聊默认模型' }, h(Select, { value: val(cm.groupDefault), width: 280, options: optsFor(val(cm.groupDefault)), onChange: (v) => setCm({ groupDefault: toSel(v) }) })),
        h('div', { style: { marginTop: 8 } }, h(Btn, { small: true, kind: 'ghost', onClick: () => setOpen(!open) }, (open ? '收起' : '展开') + '单个 QQ / 群的例外（' + rows.length + '）')),
        open ? h('div', { style: { marginTop: 8 } },
          rows.length === 0 ? h('div', { className: 'ab-muted', style: { marginBottom: 10 } }, '还没有单独设置的 QQ 或群。') :
            rows.map((r) => h(Row, { key: r.kind + r.id, label: (r.kind === 'private' ? '私聊 ' : '群 ') + r.id }, h('span', { className: 'ab-muted' }, label(r.sel)), h(Btn, { small: true, kind: 'ghost', onClick: () => remove(r.kind, r.id) }, '移除'))),
          h('div', { className: 'ab-flex' },
            h(Seg, { value: add.kind, onChange: (v) => setAdd({ ...add, kind: v }), options: [{ value: 'private', label: '私聊' }, { value: 'group', label: '群' }] }),
            h('input', { className: 'ab-input', placeholder: add.kind === 'private' ? 'QQ 号' : '群号', value: add.id, onChange: (e) => setAdd({ ...add, id: e.target.value.replace(/\D/g, '') }) }),
            h(Select, { value: add.sel, width: 220, options: base.filter((o) => o.value), placeholder: '选模型', onChange: (v) => setAdd({ ...add, sel: v }) }),
            h(Btn, { small: true, disabled: !add.id || !add.sel, onClick: addRow }, '添加'))) : null)
    }

    function Model({ draft, setDraft, toast }) {
      const [list, setList] = useState(null)
      const [ping, setPing] = useState({})
      useEffect(() => { get('/models').then((r) => setList(r.list || [])) }, [])
      const key = (m) => m.provider + '::' + m.model
      const cur = draft.model.provider && draft.model.model ? draft.model.provider + '::' + draft.model.model : ''
      const curModel = cur && list ? list.find((m) => key(m) === cur) : null
      // reasoning === null 表示 DSH 明确说这个模型不支持思考强度（本地 Ollama 之类）
      const noReasoning = Boolean(curModel && curModel.reasoning === null)
      // 视觉能力：自动时把 DSH 的声明显示出来，主人一眼能看出会不会降级
      const autoVision = curModel ? curModel.vision : undefined
      const visionHint = draft.model.vision === 'on'
        ? '强制当「能看图」；模型其实看不了的话，带图的那一轮会报错'
        : draft.model.vision === 'off'
          ? '强制当「看不懂」：收到图片只给一行文字提示，不会把图塞给模型'
          : autoVision === true
            ? '自动：DSH 说这个模型支持看图'
            : autoVision === false
              ? '自动：DSH 说这个模型看不了图，会自动降级成文字提示'
              : '自动：DSH 没声明，默认照发；真看不了就手动选「不支持」'
      const test = async (m) => {
        setPing({ ...ping, [key(m)]: '测速中…' })
        const r = await post('/model/ping', { provider: m.provider, model: m.model })
        setPing((p) => ({ ...p, [key(m)]: r.ok ? (r.ms / 1000).toFixed(1) + ' 秒' : '失败：' + (r.message || '') }))
      }
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '聊天用的模型', desc: '新建的 QQ 会话按这里的设置来；已有会话也可以在 DSH 里点开单独切换。聊天对速度很敏感，可以先点「测速」挑个快的。' },
          h(Row, { label: '思考强度', hint: noReasoning ? '这个模型不支持思考强度，会自动忽略' : '聊天建议「低」，回得快' }, h(Seg, { value: draft.model.reasoningEffort || 'low', disabled: noReasoning, onChange: (v) => setDraft(setPath(draft, 'model.reasoningEffort', v)), options: [{ value: 'low', label: '低' }, { value: 'high', label: '高' }, { value: 'max', label: '最高' }] })),
          h(Row, { label: '视觉能力', hint: visionHint }, h(Seg, {
            value: draft.model.vision || 'auto',
            onChange: (v) => setDraft(setPath(draft, 'model.vision', v)),
            options: [{ value: 'auto', label: '自动' }, { value: 'on', label: '支持' }, { value: 'off', label: '不支持' }],
          })),
          h(Row, { label: '模型' },
            h(Select, {
              value: cur, width: 280,
              options: [{ value: '', label: '跟随 DSH 默认', desc: '和你在 DSH 里平时用的一样' }].concat((list || []).map((m) => ({ value: key(m), label: m.name, desc: m.provider, group: m.provider }))),
              onChange: (v) => { const [p, ...m] = v.split('::'); setDraft(setPath(setPath(draft, 'model.provider', v ? p : ''), 'model.model', v ? m.join('::') : '')) },
            }),
            cur ? h(Btn, { small: true, onClick: () => test({ provider: draft.model.provider, model: draft.model.model }) }, '测速') : null,
            cur && ping[cur] ? h('span', { className: 'ab-muted ab-small' }, ping[cur]) : null),
        ),
        h(Card, { title: '每轮工具次数', desc: '一轮回复里她最多调用几次插件工具（画图、群管、翻聊天记录……），防止反复调用烧额度。DSH 自带的电脑工具不算在内。' },
          h(Row, { label: '每轮最多' }, h(Range, { min: 1, max: 20, value: draft.toolCallsPerTurn || 6, onChange: (v) => setDraft(setPath(draft, 'toolCallsPerTurn', v)), fmt: (v) => v + ' 次' }))),
        h(ChatModels, { draft, setDraft, list }),
        h(RoleModels, { draft, setDraft, list }),
        h(Card, { title: '可用的模型', desc: '点「测速」会真的问一次模型（花一点点额度），看它回一句话要多久。' },
          list === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : list.length === 0 ? h(Empty, { text: 'DSH 没有列出模型' }) :
            h('table', { className: 'ab-table' }, h('tbody', null, list.map((m) => h('tr', { key: key(m) },
              h('td', null, m.name), h('td', { className: 'ab-muted' }, m.provider),
              h('td', null, ping[key(m)] || ''),
              h('td', { style: { textAlign: 'right' } }, h(Btn, { small: true, kind: 'ghost', onClick: () => test(m) }, '测速'), h(Btn, { small: true, kind: 'ghost', onClick: () => { setDraft(setPath(setPath(draft, 'model.provider', m.provider), 'model.model', m.model)); toast('选好了，记得保存') } }, '用这个')))))),
        ),
      )
    }

    const ROLES = [
      { id: 'replyer', label: '回复改写', hint: '不选 = 不改写，聊天会话直接写最终回复（最快）。选了会多一次模型调用，按人设的说话方式改措辞。', inherit: '不改写' },
      { id: 'vision', label: '看图起名 / 识图', hint: '给表情包起名字、描述图片。必须是能看图的模型。' },
      { id: 'memory', label: '整理记忆', hint: '从聊天里提炼长期记忆、整理人物资料。' },
      { id: 'learning', label: '学说话方式', hint: '回顾相处经验、学群里的说话方式。' },
      { id: 'judge', label: '判断心情', hint: '聊完一轮判断心情变化（「心情与记忆」里打开了才用）。' },
    ]
    /** 各个后台角色用哪个模型；留空跟随上面的聊天模型。 */
    function RoleModels({ draft, setDraft, list }) {
      const key = (m) => m.provider + '::' + m.model
      return h(Card, { title: '各项工作用哪个模型', desc: '后台的活不一定要用聊天那个模型：便宜快的模型干杂活，能看图的模型识图。不选就跟着上面的聊天模型。' },
        ROLES.map((ro) => {
          const r = (draft.roles || {})[ro.id] || {}
          const cur = r.provider && r.model ? r.provider + '::' + r.model : ''
          const m = cur && list ? list.find((x) => key(x) === cur) : null
          const warn = ro.id === 'vision' && m && m.vision === false ? '（DSH 说这个模型看不了图）' : ''
          return h(Row, { key: ro.id, label: ro.label, hint: ro.hint + warn },
            h(Select, {
              value: cur, width: 280,
              options: [{ value: '', label: ro.inherit || '跟随聊天模型' }].concat((list || []).map((x) => ({ value: key(x), label: x.name, desc: x.provider + (x.vision === true ? ' · 能看图' : ''), group: x.provider }))),
              onChange: (v) => { const [p, ...mm] = v.split('::'); setDraft(setPath(draft, 'roles.' + ro.id, v ? { provider: p, model: mm.join('::'), reasoningEffort: '' } : { provider: '', model: '', reasoningEffort: '' })) },
            }))
        }))
    }

    function Voice({ st, draft, setDraft, toast, reload }) {
      const f = useField(draft, setDraft)
      const [txt, setTxt] = useState('晚安啦，今天也辛苦了，明天见～')
      const [src, setSrc] = useState('')
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '说话（文字转语音）', right: f.sw('voice.enabled'), desc: '回复里写了 <voice>…</voice> 的部分会变成 QQ 语音条；对方明确要语音时一定发语音；短回复也有一定概率整条变语音。' },
          h('div', { style: { margin: '4px 0 12px' } }, f.choices('voice.provider', [
            { value: 'none', label: '不用', desc: '想发语音时改发文字' },
            { value: 'openai', label: '兼容 OpenAI 的语音接口', desc: 'POST /audio/speech：OpenAI、硅基流动等各家平台' },
            { value: 'http', label: '自己配的 HTTP 接口', desc: '本地 CosyVoice、GPT-SoVITS 或任意返回音频的服务' },
          ])),
          draft.voice.provider === 'openai' ? [
            h(Row, { key: 'u', label: '服务地址', hint: '一般以 /v1 结尾' }, f.text('voice.openai.baseUrl', { size: 'wide', placeholder: 'https://api.openai.com/v1' })),
            h(Row, { key: 'k', label: 'API Key', hint: '只存在本机，不会显示出来' }, f.text('voice.openai.apiKey', { type: 'password', placeholder: draft.voice.openai.apiKeySet ? '已保存（不改就留空）' : '没有就留空' })),
            h(Row, { key: 'm', label: '模型' }, f.text('voice.openai.model', { placeholder: 'tts-1' })),
            h(Row, { key: 'v', label: '默认音色', hint: '人设里指定了音色就用人设的' }, f.text('voice.openai.voice', { placeholder: 'alloy' })),
            h(Row, { key: 'f', label: '音频格式' }, f.select('voice.openai.format', [{ value: 'mp3', label: 'mp3' }, { value: 'wav', label: 'wav' }, { value: 'opus', label: 'opus' }], { width: 140 })),
          ] : null,
          draft.voice.provider === 'http' ? [
            h(Row, { key: 'p', label: '预设', hint: '点一下按常见服务填好，再改地址' },
              h(Btn, { small: true, kind: 'ghost', onClick: () => setDraft(setPath(draft, 'voice.httpApi', { ...draft.voice.httpApi, method: 'POST', url: 'http://127.0.0.1:50000/inference_sft', bodyType: 'form', body: 'tts_text={text}&spk_id=%E4%B8%AD%E6%96%87%E5%A5%B3', response: 'audio', audioFormat: 'pcm_s16le', sampleRate: 22050 })) }, 'CosyVoice'),
              h(Btn, { small: true, kind: 'ghost', onClick: () => setDraft(setPath(draft, 'voice.httpApi', { ...draft.voice.httpApi, method: 'GET', url: 'http://127.0.0.1:9880/tts?text={text}&text_lang=zh&ref_audio_path=&prompt_text=&prompt_lang=zh&media_type=wav', bodyType: 'none', body: '', response: 'audio', audioFormat: 'auto', sampleRate: 32000 })) }, 'GPT-SoVITS')),
            h(Row, { key: 'm', label: '请求方式' }, f.select('voice.httpApi.method', [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }], { width: 120 })),
            h(Row, { key: 'u', label: '地址', hint: '{text} 换成要念的话，{voice} 换成音色' }, f.text('voice.httpApi.url', { size: 'wide', placeholder: 'http://127.0.0.1:8000/tts' })),
            draft.voice.httpApi.method === 'POST' ? h(Row, { key: 'bt', label: '请求体格式' }, f.select('voice.httpApi.bodyType', [{ value: 'json', label: 'JSON' }, { value: 'form', label: '表单' }, { value: 'none', label: '没有请求体' }], { width: 160 })) : null,
            draft.voice.httpApi.method === 'POST' && draft.voice.httpApi.bodyType !== 'none' ? h(Row, { key: 'b', label: '请求体模板', hint: 'JSON 例子：{"text":"{text}","voice":"{voice}"}' }, f.text('voice.httpApi.body', { size: 'wide' })) : null,
            h(Row, { key: 'r', label: '返回的是' }, f.select('voice.httpApi.response', [{ value: 'audio', label: '音频本身（wav / mp3 / 裸 PCM）' }, { value: 'json-base64', label: 'JSON 里的 base64' }, { value: 'json-url', label: 'JSON 里的音频地址' }], { width: 260 })),
            draft.voice.httpApi.response !== 'audio' ? h(Row, { key: 'j', label: 'JSON 路径', hint: '例如 data.audio' }, f.text('voice.httpApi.jsonPath')) : null,
            h(Row, { key: 'af', label: '音频编码', hint: '只有明确返回裸 PCM 的接口才选第二项' }, f.select('voice.httpApi.audioFormat', [{ value: 'auto', label: '自动识别标准音频文件' }, { value: 'pcm_s16le', label: '裸 PCM · 16 位小端单声道' }], { width: 260 })),
            h(Row, { key: 's', label: '裸 PCM 的采样率', hint: 'CosyVoice 1 是 22050，CosyVoice 2 是 24000' }, f.select('voice.httpApi.sampleRate', [{ value: 22050, label: '22050 Hz' }, { value: 24000, label: '24000 Hz' }, { value: 32000, label: '32000 Hz' }], { width: 160 })),
          ] : null,
          h(Row, { label: '私聊短回复变语音的概率' }, f.percent('voice.autoChance')),
          h(Row, { label: '群聊短回复变语音的概率', hint: '设为 0 保留文字，减少等待；明确要求语音或主动使用语音标记仍会合成' }, f.percent('voice.groupAutoChance')),
          h(Row, { label: '多短算短回复' }, f.range('voice.autoMaxChars', 10, 200, 5, (v) => v + ' 字')),
          h(Row, { label: '试听', hint: '先保存设置再试听' },
            h('input', { className: 'ab-input', value: txt, onChange: (e) => setTxt(e.target.value) }),
            h(Btn, { small: true, onClick: async () => { const r = await post('/voice/test', { text: txt }); if (r.ok) setSrc('data:' + r.mime + ';base64,' + r.data); else toast(r.message) } }, '生成'),
            src ? h('audio', { src, controls: true, autoPlay: true, style: { height: 32 } }) : null),
        ),
        h(Card, { title: '听语音（语音转文字）', right: f.sw('voice.asr'), desc: '别人发来的语音会先转成文字再交给她：优先用 QQ 自带的转文字，不行再用 DSH 自带的语音识别（要在 DSH「插件」里开启「语音输入」）。' },
          h(AsrStatus, { toast })),
      )
    }

    function AsrStatus({ toast }) {
      const [s, setS] = useState(null),[busy,setBusy]=useState(false),[result,setResult]=useState(null)
      const audioRef=useRef(null)
      const load = () => get('/voice/asr-status').then(setS)
      useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t) }, [])
      const phase = s && s.enabled ? ({ ready: '已就绪', standby: '已就绪（休眠中）', idle: '还没下载模型', preparing: '正在下载模型…', downloading: '正在下载模型…', failed: '下载失败' }[s.phase] || s.phase) : null
      const run=async body=>{setBusy(true);setResult(null);try{const r=await post('/voice/asr-test',body);setResult(r);if(!r.ok)toast(r.message||'没有识别到文字','err')}catch(e){toast(e.message,'err')}finally{setBusy(false)}}
      return h('div',null,h('div', { className: 'ab-flex' },
        h('span', { className: 'ab-pill' }, h('i', { className: cx('ab-dot', s && s.enabled && ['ready', 'standby'].includes(s.phase) ? 'ok' : s && s.enabled ? 'warn' : '') }), s === null ? '查询中…' : s.enabled ? 'DSH 识别：' + phase : 'DSH 识别：没开启（DSH「插件」→「语音输入」）'),
        s && s.enabled && !['ready', 'standby'].includes(s.phase) ? h(Btn, { small: true,disabled:busy,onClick: async () => {setBusy(true);try{const r = await post('/voice/asr-prepare'); toast(r.message); load()}finally{setBusy(false)} } }, '下载识别模型') : null,
        s && s.enabled && ['ready', 'standby'].includes(s.phase) ? h(Fragment,null,
          h(Btn,{small:true,disabled:busy,onClick:()=>run({text:'今天想吃白米饭'})},busy?'识别中…':'合成一句再识别'),
          h(Btn,{small:true,disabled:busy,onClick:()=>audioRef.current?.click()},'上传音频识别'),
          h('input',{ref:audioRef,type:'file',accept:'audio/*,.wav,.mp3,.ogg,.m4a,.flac',style:{display:'none'},onChange:async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;if(file.size>20*1024*1024)return toast('音频最多 20 MiB','err');setBusy(true);try{await run({audioBase64:String(await fileData(file)).split(',')[1]})}catch(error){setBusy(false);toast(error.message,'err')}}})) : null),
        h('p',{className:'ab-muted ab-small'},'上传已有音频仅调用当前 DSH 识别服务；“合成一句再识别”还会调用保存的 TTS 服务。'),
        result?h('div',{className:cx('ab-note',result.ok?'':'warn'),'aria-live':'polite'},result.ok?'识别结果（'+result.ms+' ms）：'+result.heard:result.message||'未识别到文字'):null)
    }

    const fileData = file => new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('文件读取失败'));r.readAsDataURL(file)})
    const STICKER_STATES={pending:'待处理',approved:'可用',rejected:'已拒绝',disabled:'已停用',deleted:'已删除',quarantined:'旧库隔离'}
    const STICKER_ANALYSIS={pending:'未识别/待处理',done:'识别完成',failed:'识别失败',needs_frames:'自动取帧未完成',unknown:'识别结果未知',canceled:'识别已取消'}
    const STICKER_TASKS={collect:'收藏下载',analyze:'模型识别',sync:'QQ 收藏同步',import:'QQ 收藏导入'}
    const STICKER_TASK_STATES={queued:'排队中',running:'执行中',done:'完成',failed:'失败',unknown:'结果未知',canceled:'已取消'}
    const STICKER_QQ={unidentified:'已导入，缺少收藏 ID',idle:'未同步',queued:'待同步',running:'同步中',synced:'已确认收藏',failed:'同步失败',unknown:'同步结果未知',removed:'已移除收藏'}
    const stickerChatParams=chatId=>chatId?{chatId}:{}
    function Stickers({ st, draft, setDraft, toast }) {
      const f=useField(draft,setDraft),[chatScope,setChatScope]=useState({account:st.config.botQQ,chat:'private:'+st.config.ownerQQ,persona:''}),[working,setWorking]=useState(false)
      const perChat=st.config.stickers.libraryScope==='chat',scope={account:st.config.botQQ,chat:perChat?chatScope.chat:'',persona:''}
      return h('div',{className:'ab-grid'},
        h(Card,{title:perChat?'表情包（兼容聊天隔离）':'表情包 · 当前机器人共用图库',right:f.sw('stickers.enabled'),desc:'正常素材可自动收集、识别并加入可用图库，回复时自动匹配；平时只需查看、删除不想要的表情或处理失败。来源聊天用于溯源，账号共用模式不限制素材只能在来源聊天使用。设置修改后需保存。'},
          h(Row,{label:'1. 自动收集表情',hint:'从已授权聊天收到的表情保存到本机图库'},f.sw('stickers.collect')),
          h(Row,{label:'2. 自动识别内容',hint:'后台调用视觉模型生成描述和标签；关闭后暂停识别队列'},f.sw('stickers.caption')),
          h(Row,{label:'3. 正常素材自动可用',hint:'识别通过的素材自动入可用库，无需逐张手工批准；异常或不确定的素材可在人工处理中核对'},f.sw('stickers.autoReview')),
          h(Row,{label:'回复时自动配表情概率',hint:'从可用图库匹配；没有合适素材就不发。不会因此启用新的聊天。'},f.percent('stickers.autoChance')),
          h('details',null,h('summary',null,'来源与高级设置'),
            h(Row,{label:'允许收集的来源类型',hint:'仍受「权限」allow 限制，不是素材可用范围'},h('span',null,'群聊'),f.sw('stickers.fromGroups'),h('span',null,'私聊'),f.sw('stickers.fromPrivate')),
            h(Row,{label:'图库使用方式',hint:'仅影响表情包；记忆和表达与黑话仍按聊天隔离。保存后生效。'},h(Select,{value:draft.stickers.libraryScope||'account',options:[{value:'account',label:'当前机器人账号共用（默认）'},{value:'chat',label:'按聊天隔离（兼容选项）'}],onChange:value=>setDraft(setPath(draft,'stickers.libraryScope',value))})),
            h(Row,{label:'每小时收集上限'},f.num('stickers.maxPerHour',{min:0,max:200})),
            h(Row,{label:'库容量',hint:'达到上限后暂停接收；已有素材保留'},f.num('stickers.maxLibrary',{min:20,max:2000})))),
        perChat?h('details',null,h('summary',null,'兼容模式：选择聊天图库'),h('fieldset',{disabled:working,style:{border:0,padding:0,margin:0,minWidth:0}},h(ScopePicker,{st,scope:chatScope,onChange:setChatScope,persona:false}))):null,
        h(StickerWorkspace,{key:scope.account+':'+scope.chat,scope,toast,onWorking:setWorking}))
    }
    function StickerWorkspace({scope,toast,onWorking}) {
      const [items,setItems]=useState([]),[total,setTotal]=useState(0),[offset,setOffset]=useState(0),[state,setState]=useState('all'),[query,setQuery]=useState(''),[analysis,setAnalysis]=useState(''),[animated,setAnimated]=useState(''),[qq,setQQ]=useState('')
      const [queue,setQueue]=useState([]),[queueTotal,setQueueTotal]=useState(0),[queueOffset,setQueueOffset]=useState(0),[kind,setKind]=useState('analyze'),[taskState,setTaskState]=useState('failed')
      const [selected,setSelected]=useState({}),[tasks,setTasks]=useState({}),[reviewed,setReviewed]=useState({}),[result,setResult]=useState(null),[runtime,setRuntime]=useState(null),[stats,setStats]=useState(null)
      const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[actionError,setActionError]=useState(''),[name,setName]=useState(''),[sync,setSync]=useState(false),[pending,setPending]=useState(null)
      const seq=useRef(0),gate=useRef(false),pendingRef=useRef(null),scopeRef=useRef(scope),fileRef=useRef(null),alive=useRef(true),pageSize=30
      scopeRef.current={account:scope.account,chat:scope.chat}
      const itemParams={...stickerChatParams(scope.chat),status:state,query,analysis,animated,qq},taskParams={...stickerChatParams(scope.chat),kind,state:taskState}
      const load=useCallback(async()=>{
        const id=++seq.current;setLoading(true)
        try {
          const [r,q,s]=await Promise.all([get('/stickers?'+new URLSearchParams({...itemParams,limit:pageSize,offset})),get('/stickers/queue?'+new URLSearchParams({...taskParams,limit:pageSize,offset:queueOffset})),get('/stickers/stats?'+new URLSearchParams(stickerChatParams(scope.chat)))])
          if(id!==seq.current||!alive.current)return
          if(!r.ok||!q.ok||!s.ok)throw new Error(r.message||q.message||s.message||'读取表情库失败')
          setItems(r.items);setTotal(r.total);setQueue(q.items);setQueueTotal(q.total);setRuntime(q.runtime);setStats(s);setError('')
          if(offset>=r.total&&offset>0)setOffset(Math.max(0,Math.ceil(r.total/pageSize)-1)*pageSize)
          if(queueOffset>=q.total&&queueOffset>0)setQueueOffset(Math.max(0,Math.ceil(q.total/pageSize)-1)*pageSize)
        } catch(e) {if(id===seq.current&&alive.current)setError(e.message)} finally {if(id===seq.current&&alive.current)setLoading(false)}
      },[scope.chat,state,query,analysis,animated,qq,kind,taskState,offset,queueOffset])
      useEffect(()=>{alive.current=true;return()=>{alive.current=false;seq.current++;pendingRef.current=null;onWorking(false)}},[])
      useEffect(()=>{load();return()=>{seq.current++}},[load])
      const reportActionError=e=>{if(alive.current){toast(e.message,'err');setActionError(e.message)}}
      const run=async(fn,confirmation=null)=>{
        if(gate.current||!alive.current||pendingRef.current!==confirmation)return
        gate.current=true;setBusy(true);setActionError('');onWorking(true)
        try{return await fn()}catch(e){reportActionError(e)}finally{gate.current=false;if(pendingRef.current===confirmation)pendingRef.current=null;if(alive.current){setBusy(false);setPending(null);onWorking(false)}}
      }
      const requestConfirmation=request=>{
        if(gate.current||pendingRef.current||!alive.current||loading||error)return
        // 独立复制并冻结请求；确认期间的刷新、旧事件或对象更新不能改变授权范围。
        const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value)}return value}
        const snapshot=freeze(JSON.parse(JSON.stringify({...request,scope:{account:scope.account,chat:scope.chat},body:{...request.body,...stickerChatParams(scope.chat)}})))
        pendingRef.current=snapshot;setPending(snapshot);setActionError('');onWorking(true)
      }
      const cancelConfirmation=request=>{
        if(gate.current||!alive.current||pendingRef.current!==request)return
        pendingRef.current=null;setPending(null);onWorking(false)
      }
      const postAction=async(path,body)=>{
        const r=await post(path,body)
        if(!r.ok)toast(r.message||r.reason||'操作失败','err')
        else if(r.sync?.ok===false)toast('本地操作成功；QQ 同步未完成：'+(r.sync.reason||r.sync.message||r.sync.state),'err')
        else toast(r.message||'操作已登记')
        await load();return r
      }
      const act=(path,body={},confirmation)=>confirmation?requestConfirmation({...confirmation,path,body,targets:[{id:body.id||body.taskId,version:body.expectedRevision!=null?'v'+body.expectedRevision:body.expectedState!=null?(STICKER_TASK_STATES[body.expectedState]||body.expectedState)+' · 尝试 '+body.expectedAttempts+' 次':'隔离项'}]}):run(()=>postAction(path,{...body,...stickerChatParams(scope.chat)}))
      const changeIdle=(setter,value)=>{if(!gate.current&&!pendingRef.current&&alive.current)setter(value)}
      const resetFilter=(setter,value)=>{if(gate.current||pendingRef.current)return;setter(value);setOffset(0);setSelected({});setReviewed({});setResult(null)}
      const resetTasks=(setter,value)=>{if(gate.current||pendingRef.current)return;setter(value);setQueueOffset(0);setTasks({});setResult(null)}
      const toggle=(setter,it,checked)=>changeIdle(setter,old=>{const next={...old};if(checked)next[it.id]=it;else delete next[it.id];return next})
      const selectPage=(setter,rows)=>changeIdle(setter,old=>({...old,...Object.fromEntries(rows.map(it=>[it.id,it]))}))
      const allFiltered=(isTask=false)=>run(async()=>{
        const r=await get((isTask?'/stickers/queue?':'/stickers?')+new URLSearchParams({...(isTask?taskParams:itemParams),limit:200,offset:0}))
        if(!r.ok)throw new Error(r.message||'读取筛选结果失败')
        if(r.total>200)throw new Error('当前筛选超过 200 项，请缩小筛选或按页处理；尚未新增选择')
        ;(isTask?setTasks:setSelected)(Object.fromEntries(r.items.map(it=>[it.id,it])))
      })
      const performBatch=(action,isTask=false)=>{
        if(gate.current||pendingRef.current||!alive.current)return
        try{
          const rows=Object.values(isTask?tasks:selected)
          if(!rows.length)return
          if(rows.length>200)throw new Error('每批最多 200 项，请取消部分选择')
          const label={approve:'批准使用',reject:'拒绝',disable:'停用',delete:'删除本地条目',analysis_retry:'重新识别（可能计费）',task_retry:'重试'+STICKER_TASKS[kind]}[action]
          if(action==='approve'&&rows.some(it=>it.animated&&reviewed[it.id]!==it.revision))throw new Error('选中动画尚未逐项确认完整原图；请展开动画审核，或取消选择这些素材')
          const entries=rows.map(it=>isTask?{id:it.id,expectedState:it.state,expectedAttempts:it.attempts}:{id:it.id,expectedRevision:it.revision,reviewedOriginal:reviewed[it.id]===it.revision})
          const note=action==='approve'?'请确认已逐项审核所选素材。原本要求同步 QQ 的素材会独立排队同步。':action==='delete'?'仅删除本地条目，并阻止自动收藏回来；不会删除 QQ 收藏。':action==='analysis_retry'||(isTask&&kind==='analyze')?'识别可能计费；结果未知的任务不能直接重试。':isTask&&kind==='sync'?'仅重试明确失败的 QQ 收藏同步；结果未知的任务须先逐项核对。':'请核对本次操作的条目和范围。'
          requestConfirmation({path:'/stickers/batch',batch:true,isTask,label,note,body:{action,kind:isTask?kind:undefined,entries},targets:rows.map(it=>({id:it.id,name:it.name,version:isTask?(STICKER_TASK_STATES[it.state]||it.state)+' · 尝试 '+it.attempts+' 次':'v'+it.revision}))})
        }catch(e){reportActionError(e)}
      }
      const submitConfirmation=request=>{
        if(gate.current||!alive.current||pendingRef.current!==request)return
        if(scopeRef.current.account!==request.scope.account||scopeRef.current.chat!==request.scope.chat){cancelConfirmation(request);reportActionError(new Error('图库范围已改变，请重新选择操作'));return}
        return run(async()=>{
          if(!request.batch)return postAction(request.path,request.body)
          const r=await post(request.path,request.body)
          if(!r.ok)throw new Error(r.message||r.reason||'批量操作未受理')
          if(!alive.current)return r
          setResult(r)
          const successful=new Set(r.results.filter(x=>x.ok).map(x=>x.id))
          ;(request.isTask?setTasks:setSelected)(old=>Object.fromEntries(Object.entries(old).filter(([id])=>!successful.has(id))))
          toast('成功 '+r.succeeded+' / 失败 '+r.failed+(r.syncFailed?'；QQ 同步另有 '+r.syncFailed+' 项未完成':''),r.failed||r.syncFailed?'err':undefined)
          await load();return r
        },request)
      }
      const upload=files=>run(async()=>{
        const results=[]
        for(const file of [...files]){
          let r
          try{if(file.size>5*1024*1024)throw new Error('超过 5 MB');r=await post('/sticker/upload',{...stickerChatParams(scope.chat),data:await fileData(file),name,toQQ:sync})}catch(e){r={ok:false,message:e.message}}
          results.push({id:file.name,ok:r.ok,message:r.message||r.reason,state:r.item?.state})
        }
        const succeeded=results.filter(r=>r.ok).length
        setResult({total:results.length,succeeded,failed:results.length-succeeded,results});await load()
      })
      const held=busy||Boolean(pending),locked=held||loading||Boolean(error),selectedCount=Object.keys(selected).length,taskCount=Object.keys(tasks).length
      const controls=(isTask=false)=>{const rows=isTask?queue:items,chosen=isTask?tasks:selected,setter=isTask?setTasks:setSelected,count=Object.keys(chosen).length
        return h('div',{className:'ab-flex',style:{margin:'12px 0',flexWrap:'wrap'}},h('b',{'aria-live':'polite'},'已选 '+count+' 项 · 本页选中 '+rows.filter(it=>chosen[it.id]).length+'/'+rows.length),
          h(Btn,{small:true,disabled:locked||!rows.length,onClick:()=>selectPage(setter,rows)},'全选当前页'),h(Btn,{small:true,disabled:locked,onClick:()=>allFiltered(isTask)},'全选当前筛选（最多200）'),
          h(Btn,{small:true,disabled:held||!count,onClick:()=>changeIdle(setter,{})},'取消全部选择'))}
      const pagination=(count,page,change)=>h('div',{className:'ab-flex',style:{marginTop:12}},h(Btn,{small:true,disabled:locked||page===0,onClick:()=>changeIdle(change,Math.max(0,page-pageSize))},'上一页'),h('span',null,'第 '+(Math.floor(page/pageSize)+1)+' / '+Math.max(1,Math.ceil(count/pageSize))+' 页 · '+count+' 项'),h(Btn,{small:true,disabled:locked||page+pageSize>=count,onClick:()=>changeIdle(change,page+pageSize)},'下一页'))
      const options=(labels,all)=>[{value:'',label:all},...Object.entries(labels).map(([value,label])=>({value,label}))]
      return h('div',{className:'ab-grid'},
        pending?h(StickerConfirmation,{request:pending,busy,onConfirm:()=>submitConfirmation(pending),onCancel:()=>cancelConfirmation(pending)}):null,
        h(Card,{title:'当前生效状态',right:h(Btn,{small:true,disabled:held,onClick:()=>{if(!gate.current&&!pendingRef.current)return load()}},'刷新状态')},
          runtime?h('div',{className:'ab-note'},'表情模块 '+(runtime.enabled?'开启':'关闭')+' · 自动收藏 '+(runtime.collect?'开启':'关闭')+' · 模型识别 '+(runtime.caption?'开启':'关闭')+' · 自动批准 '+(runtime.autoReview?'开启':'关闭')+' · 自动配图概率 '+Math.round((runtime.autoChance||0)*100)+'%'+(runtime.dryRun?' · 试运行暂停 QQ 任务':'')):null,
          stats?h('p',null,(scope.chat?'当前聊天图库':'当前机器人共用图库')+'：可用 '+stats.approved+' · 待处理 '+stats.pending+' · 拒绝 '+stats.rejected+' · 停用 '+stats.disabled+' · 已删除 '+stats.deleted+'。'+(stats.approved===0?'自动识别通过后，可用素材会出现在这里。':'')):null,
          h('p',{className:'ab-small ab-muted'},'自动流程：收集 → 识别审核 → 加入可用图库 → 回复时匹配。普通素材无需逐张操作；失败、动画或结果未知的任务可在下方处理。QQ 收藏同步是独立功能，不影响本机图库的概念。'),
          error||actionError?h('div',{className:'ab-note err',role:'alert'},error||actionError):null),
        result?h(Card,{title:'操作结果 · 成功 '+result.succeeded+' / 失败 '+result.failed,desc:'成功项已取消选择，失败项保留。版本或任务状态改变时请刷新并重新勾选。'},
          ...result.results.map((r,i)=>h('div',{key:r.id+':'+i,className:'ab-note'},(r.ok?'成功':'失败')+' · '+r.id+' · '+(r.message||r.code||STICKER_STATES[r.state]||STICKER_TASK_STATES[r.state]||r.state||'已登记')+(r.taskId?' · 任务 '+r.taskId:'')+(r.sync?' · QQ：'+(r.sync.reason||r.sync.message||STICKER_QQ[r.sync.state]||r.sync.state):'')))):null,
        h(Card,{title:(scope.chat?'聊天图库':'机器人共用图库')+' · '+total+' 项',desc:scope.chat?'当前为兼容聊天隔离模式。':'这里展示当前机器人账号的全部表情；来源聊天只用于溯源，不是可用范围。'},
          h('div',{className:'ab-flex',style:{margin:'12px 0',flexWrap:'wrap'}},h('input',{className:'ab-input wide','aria-label':'搜索表情',placeholder:'搜索名字、描述或标签',disabled:held,value:query,onChange:e=>resetFilter(setQuery,e.target.value)}),h(Btn,{small:true,kind:'danger',disabled:locked||!selectedCount,onClick:()=>performBatch('delete')},'批量删除本地')),
          h('details',null,h('summary',null,'更多筛选与人工处理（通常无需操作）'),
          h('fieldset',{disabled:held,style:{border:0,padding:0,minWidth:0}},h('div',{className:'ab-flex',style:{flexWrap:'wrap'}},
            h(Select,{value:state,onChange:v=>resetFilter(setState,v),options:[{value:'all',label:'全部审核状态'},...Object.entries(STICKER_STATES).map(([value,label])=>({value,label}))]}),
            h(Select,{value:analysis,onChange:v=>resetFilter(setAnalysis,v),options:options(STICKER_ANALYSIS,'全部识别状态')}),h(Select,{value:animated,onChange:v=>resetFilter(setAnimated,v),options:[{value:'',label:'全部格式'},{value:'true',label:'GIF / 动画'},{value:'false',label:'静态图片'}]}),
            h(Select,{value:qq,onChange:v=>resetFilter(setQQ,v),options:options(STICKER_QQ,'全部 QQ 状态')}))),
          state!=='quarantined'?controls():h('div',{className:'ab-note warn'},'隔离库没有可靠聊天来源，仅支持逐项分配或删除；不会纳入批量批准。'),
          state!=='quarantined'?h('div',{className:'ab-flex',style:{flexWrap:'wrap'}},...Object.entries({approve:'批量通过',reject:'批量拒绝',disable:'批量停用',analysis_retry:'批量重试识别'}).map(([action,label])=>h(Btn,{key:action,small:true,disabled:locked||!selectedCount,onClick:()=>performBatch(action)},label))):null),
          h('details',null,h('summary',null,'手动上传与 QQ 收藏导入'),h('div',{className:'ab-flex',style:{margin:'12px 0',flexWrap:'wrap'}},h('input',{className:'ab-input',placeholder:'上传备注（可不填）','aria-label':'上传表情备注',disabled:held,value:name,onChange:e=>changeIdle(setName,e.target.value)}),h('label',null,h('input',{type:'checkbox',checked:sync,disabled:held,onChange:e=>changeIdle(setSync,e.target.checked)}),' 审核通过后同步 QQ 收藏（可选）'),h('input',{type:'file',ref:fileRef,accept:'image/*',multiple:true,hidden:true,onChange:e=>{const files=[...e.target.files];e.target.value='';upload(files)}}),h(Btn,{small:true,disabled:locked,onClick:()=>fileRef.current.click()},'上传到图库'),h(Btn,{small:true,disabled:locked,onClick:()=>act('/sticker/import-qq')},'导入 QQ 收藏'))),
          items.length?h('div',{className:'ab-grid'},...items.map(it=>state==='quarantined'?h('div',{key:it.id,className:'ab-card'},h('b',null,it.legacy?.name||it.id),h('p',null,it.error||it.reason),h('div',{className:'ab-flex'},h(Btn,{small:true,disabled:locked,onClick:()=>act('/sticker/legacy/assign',{id:it.id})},'导入图库待处理区'),h(Btn,{small:true,disabled:locked,onClick:()=>act('/sticker/legacy/delete',{id:it.id},{label:'删除隔离项',note:'删除此隔离项，并阻止自动收藏回来。'})},'删除隔离项'))):h(StickerCell,{key:it.id+':'+it.revision,it,chatId:scope.chat,act,busy:locked,selected:Boolean(selected[it.id]),onSelect:value=>toggle(setSelected,it,value),reviewed:reviewed[it.id]===it.revision,onReviewed:value=>changeIdle(setReviewed,old=>({...old,[it.id]:value?it.revision:0}))}))):h(Empty,{text:loading?'正在读取…':'图库中没有符合条件的表情；开启自动流程后，收到的正常表情会自动加入'}),pagination(total,offset,setOffset)),
        h('details',null,h('summary',null,'处理失败与后台任务 · '+queueTotal+' 项'),h(Card,{title:'后台任务',desc:'默认显示识别失败。识别与 QQ 同步分别重试；结果未知须先核对。动画先在本机取样再识别，取样仅覆盖部分内容。'},
          h('fieldset',{disabled:held,style:{border:0,padding:0}},h('div',{className:'ab-flex'},h(Select,{value:kind,onChange:v=>resetTasks(setKind,v),options:Object.entries(STICKER_TASKS).map(([value,label])=>({value,label}))}),h(Select,{value:taskState,onChange:v=>resetTasks(setTaskState,v),options:options(STICKER_TASK_STATES,'全部任务状态')}))),
          controls(true),h(Btn,{small:true,disabled:locked||!taskCount,onClick:()=>performBatch('task_retry',true)},'批量重试'+STICKER_TASKS[kind]+'（仅明确失败）'),
          ...queue.map(t=>h(StickerTask,{key:t.id+':'+t.state+':'+t.attempts,t,act,busy:locked,selected:Boolean(tasks[t.id]),onSelect:value=>toggle(setTasks,t,value)})),!queue.length?h(Empty,{text:'此筛选下暂无任务'}):null,pagination(queueTotal,queueOffset,setQueueOffset))))
    }
    function StickerConfirmation({request,busy,onConfirm,onCancel}) {
      const panelRef=useRef(null),cancelRef=useRef(null)
      useEffect(()=>{panelRef.current?.scrollIntoView?.({block:'nearest'});cancelRef.current?.focus?.({preventScroll:true})},[request])
      return h('section',{className:'ab-card',role:'alertdialog','aria-modal':false,'aria-label':'表情操作确认','aria-describedby':'sticker-confirm-note','aria-busy':busy,ref:panelRef,onKeyDown:e=>{if(e.key==='Escape'&&!busy){e.preventDefault();e.stopPropagation();onCancel()}}},
        h('h3',null,'确认'+request.label+' · '+request.targets.length+' 项'),
        h('p',{className:'ab-small'},'机器人 '+request.scope.account+(request.scope.chat?' · 聊天 '+request.scope.chat:' · 账号共用图库')),
        h('p',{id:'sticker-confirm-note',className:'ab-note warn'},request.note),
        request.body.emojiId?h('p',null,'QQ 收藏 ID：'+request.body.emojiId):null,request.body.reason?h('p',null,'核对 / 审核说明：'+request.body.reason):null,
        h('details',null,h('summary',null,'本次操作的条目与版本（已固定）'),h('ul',{style:{maxHeight:180,overflow:'auto',overflowWrap:'anywhere'}},...request.targets.map(it=>h('li',{key:it.id},(it.name?it.name+' · ':'')+it.id+' · '+it.version)))),
        h('p',{className:'ab-small ab-muted',role:'status'},busy?'正在提交，请等待结果；已发出的请求不能在此撤销。':'尚未提交。取消后可调整选择；版本或任务状态改变时会由服务端拒绝。'),
        h('div',{className:'ab-flex'},h('button',{type:'button',className:'ab-btn',ref:cancelRef,disabled:busy,onClick:onCancel},'取消本次操作'),h(Btn,{small:true,kind:request.body.action==='delete'||request.path.endsWith('/delete')?'danger':undefined,disabled:busy,onClick:onConfirm},busy?'正在提交…':'确认提交')))
    }
    function StickerCell({ it, chatId, act, busy, selected, onSelect, reviewed, onReviewed }) {
      const [draft,setDraft]=useState(Object.fromEntries(['name','description','ocr','tags','emotions','suitable','unsuitable'].map(k=>[k,Array.isArray(it[k])?it[k].join('、'):it[k]||''])))
      const [reason,setReason]=useState(''),[qqId,setQQId]=useState(''),[frameAt,setFrameAt]=useState(0),fileRef=useRef(null)
      const body={id:it.id,expectedRevision:it.revision,reason,reviewedOriginal:reviewed},change=(k,v)=>setDraft({...draft,[k]:v}),locked=busy||it.state==='deleted'
      const save=()=>act('/sticker/edit',{...body,patch:Object.fromEntries(Object.entries(draft).map(([k,v])=>[k,['tags','emotions','suitable','unsuitable'].includes(k)?v.split(/[、,，\n]/).map(x=>x.trim()).filter(Boolean):v]))})
      return h('div',{className:'ab-card'},h('label',null,h('input',{type:'checkbox',disabled:busy,checked:selected,onChange:e=>onSelect(e.target.checked),'aria-label':'选择表情 '+(it.name||it.id)}),' 选择此项'),
        h(Btn,{small:true,kind:'danger',disabled:locked,onClick:()=>act('/sticker/delete',{...body,fromQQ:false},{label:'删除本地条目',note:'删除本地表情，并阻止自动收藏回来；不会删除 QQ 收藏。'})},'删除本地条目'),
        h('details',null,h('summary',{className:'ab-flex'},h('img',{src:API+'/sticker/image?'+new URLSearchParams({id:it.id,...stickerChatParams(chatId)}),alt:it.name||'表情',loading:'lazy',style:{width:72,height:72,objectFit:'contain',borderRadius:8}}),h('div',{className:'body'},h('b',null,it.name||'未命名表情'),h('div',{className:'ab-muted ab-small'},STICKER_STATES[it.state]+' · '+(it.analysis?.evidence?.singleFrame?'单帧图片':it.animated?'动画':'静态')+' · '+(STICKER_ANALYSIS[it.analysis?.state]||it.analysis?.state||'待识别')),h('div',{className:'ab-muted ab-small'},'来源：'+(it.sourceLabel||it.sourceChatId||it.source?.scope?.chat||it.scope?.chat||'手动上传 / 导入')+'（仅溯源）'))),
          h('a',{href:API+'/sticker/image?'+new URLSearchParams({id:it.id,...stickerChatParams(chatId)}),target:'_blank',rel:'noreferrer'},'打开完整原图 / 动画'),
          ...[['name','名字'],['description','画面描述'],['ocr','图中文字'],['tags','标签'],['emotions','情绪'],['suitable','适用情境'],['unsuitable','不适用情境']].map(([key,label])=>h(Row,{key,label},h('input',{className:'ab-input wide',value:draft[key],disabled:locked,'aria-label':'表情'+label,onChange:e=>change(key,e.target.value)}))),
          h(Btn,{small:true,disabled:locked,onClick:save},'保存表情信息'),
          h(Row,{label:'仅手动发送',hint:'保留收藏，但自动配图不会使用'},h('input',{type:'checkbox',checked:!!it.manualOnly,disabled:locked,'aria-label':'仅手动发送',onChange:e=>act('/sticker/edit',{...body,patch:{manualOnly:e.target.checked}})})),
          it.analysis?.evidence?.coverage==='sampled_partial'?h('p',{className:'ab-note warn'},'自动取样 '+(it.frames?.length||0)+' 帧，仅为部分动画内容；不能代表完整动画。'):null,it.analysis?.error?h('p',{className:'ab-note warn'},'识别：'+it.analysis.error):null,it.qq?.error?h('p',{className:'ab-note warn'},'QQ 同步：'+it.qq.error):null,
          it.qq?.state==='unidentified'?h('div',{className:'ab-flex'},h('input',{className:'ab-input',placeholder:'已核对的 QQ 收藏 ID','aria-label':'已有 QQ 收藏 ID',value:qqId,disabled:locked,onChange:e=>setQQId(e.target.value)}),h(Btn,{small:true,disabled:locked||!qqId.trim(),onClick:()=>act('/sticker/sync/bind',{...body,emojiId:qqId.trim(),confirmedExisting:true},{label:'绑定已有 QQ 收藏',note:'请确认已核对此 ID 对应这张素材的现有 QQ 收藏。这里只登记绑定，不会新建收藏。'})},'绑定已有 QQ 收藏')):null,
          h('details',null,h('summary',null,'人工处理（异常、动画或停用）'),h(Row,{label:'审核说明'},h('input',{className:'ab-input wide',value:reason,disabled:locked,'aria-label':'表情审核说明',onChange:e=>setReason(e.target.value)})),
          it.animated?h('label',null,h('input',{type:'checkbox',disabled:locked,checked:reviewed,onChange:e=>onReviewed(e.target.checked)}),' 我已查看这张完整动画，确认适用内容（批量审核也需此确认）'):null,
          h('div',{className:'ab-flex',style:{marginTop:10,flexWrap:'wrap'}},...[['approve','批准使用'],['reject','拒绝'],['disable','停用'],['analysis/retry','重新识别'],['sync','同步 QQ 收藏']].map(([path,label])=>h(Btn,{key:path,small:true,disabled:locked||(path==='approve'&&it.animated&&!reviewed)||(path==='analysis/retry'&&it.analysis?.state==='unknown')||(path==='sync'&&(it.state!=='approved'||['unknown','unidentified'].includes(it.qq?.state))),onClick:()=>act('/sticker/'+path,body)},label)))),
          it.animated?h('details',{style:{marginTop:12}},h('summary',null,'动画关键帧（辅助识别）'),h('div',{className:'ab-note'},'关键帧不能代替完整动画审核。没有人工帧时重试识别会自动取样；上传可替换自动帧并重新排队识别。'),h('input',{className:'ab-input sm',type:'number',min:0,value:frameAt,disabled:locked,'aria-label':'关键帧时间毫秒',onChange:e=>setFrameAt(Number(e.target.value))}),h('input',{type:'file',ref:fileRef,accept:'image/png,image/jpeg,image/webp',hidden:true,onChange:async e=>{const file=e.target.files[0];e.target.value='';if(file)await act('/sticker/frames',{...body,frames:[{atMs:frameAt,data:await fileData(file)}]})}}),h(Btn,{small:true,disabled:locked||it.analysis?.state==='unknown',onClick:()=>fileRef.current.click()},'上传关键帧'),...(it.frames||[]).map((frame,i)=>h('img',{key:i,src:API+'/sticker/image?'+new URLSearchParams({id:it.id,...stickerChatParams(chatId),frame:i}),alt:(frame.selection==='sampled'?'自动取样（部分）':'人工关键帧')+' '+frame.atMs+'ms',style:{width:100,objectFit:'contain'}}))):null,
          h('details',{style:{marginTop:10}},h('summary',null,'来源与审核记录'),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},JSON.stringify({scope:it.scope,source:it.source,review:it.review,analysis:it.analysis,qq:it.qq},null,2)))))
    }
    function StickerTask({t,act,busy,selected,onSelect}) {
      const [emojiId,setEmojiId]=useState(''),[reason,setReason]=useState('')
      const body={taskId:t.id,expectedState:t.state,expectedAttempts:t.attempts}
      return h('div',{className:'ab-card',style:{marginTop:10}},h('label',null,h('input',{type:'checkbox',checked:selected,disabled:busy,onChange:e=>onSelect(e.target.checked),'aria-label':'选择任务 '+t.id}),' 选择任务'),
        h('div',{className:'ab-li'},h('div',{className:'body'},h('b',null,STICKER_TASKS[t.kind]+' · '+STICKER_TASK_STATES[t.state]+' · 尝试 '+t.attempts+' 次'),h('div',{className:'ab-small ab-muted',style:{overflowWrap:'anywhere'}},t.id),h('div',{className:'ab-small'},t.error||t.blockedReason||'')),
          t.state==='failed'?h(Btn,{small:true,disabled:busy,onClick:()=>act('/sticker/task/retry',body)},'重试'+STICKER_TASKS[t.kind]):null),
        t.output?h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},JSON.stringify(t.output,null,2)):null,
        t.kind==='analyze'&&t.state==='unknown'?h('div',null,h('p',{className:'ab-note warn'},'可能已经计费，不能盲目重发。无法核对时可人工编辑素材并审核。'),h('input',{className:'ab-input wide',placeholder:'核对服务记录的依据','aria-label':'识别未执行核对依据',value:reason,disabled:busy,onChange:e=>setReason(e.target.value)}),h(Btn,{small:true,disabled:busy||!reason.trim(),onClick:()=>act('/sticker/analysis/reconcile',{...body,confirmedNotApplied:true,reason},{label:'登记识别未执行',note:'请确认已逐项核对服务记录，此识别确实没有执行。此操作只登记核对结果，不会重新调用模型。'})},'确认识别未执行')):null,
        t.kind==='sync'&&t.state==='unknown'?h('div',{className:'ab-flex'},h('input',{className:'ab-input',placeholder:'QQ 收藏 ID','aria-label':'QQ 收藏 ID',value:emojiId,disabled:busy,onChange:e=>setEmojiId(e.target.value)}),h(Btn,{small:true,disabled:busy||(t.action!=='delete'&&!emojiId),onClick:()=>act('/sticker/sync/reconcile',{...body,confirmedApplied:true,emojiId},{label:'登记 QQ 已执行',note:'请确认已在 QQ 核对此次收藏操作确实执行成功。若之前申请了删除且刚确认的是收藏成功，原删除任务会继续排队。'})},'核对 QQ 已执行'),h(Btn,{small:true,disabled:busy,onClick:()=>act('/sticker/sync/reconcile',{...body,confirmedNotApplied:true},{label:'登记 QQ 未执行',note:'请确认已在 QQ 逐项核对这次操作确实没有执行。未知状态不能直接重发收藏任务。'})},'核对 QQ 未执行')):null)
    }

    function SpeakUp({ st, draft, setDraft, toast }) {
      const f = useField(draft, setDraft)
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '主动搭话', right: f.sw('speakUp.enabled'), desc: '目标留空时只给主人私聊；指定其他已允许的聊天后，也可向这些聊天主动搭话。目的模式会从该聊天可见的资料选择话题。' },
          h(Row, { label: '目标聊天', hint: '每行 private:QQ 或 group:群号，留空为主人私聊' }, f.list('speakUp.targets')),
          h(Row, { label: '模式' }, f.select('speakUp.mode', [{ value: 'ordinary', label: '普通' }, { value: 'purpose', label: '目的驱动' }])),
          h(Row, { label: '追问', hint: '她问了你一句、你 15~40 分钟没回，偶尔轻轻追一句（「人呢」之类），每句最多追一次' }, f.sw('speakUp.nudge')),
          h(Row, { label: '多久没聊才找你' }, f.num('speakUp.idleMinutes', { min: 5 }), h('span', { className: 'ab-muted' }, '分钟')),
          h(Row, { label: '两次之间隔', hint: '在这个范围里随机' }, f.num('speakUp.minIntervalMinutes', { min: 5 }), h('span', { className: 'ab-muted' }, '到'), f.num('speakUp.maxIntervalMinutes', { min: 5 }), h('span', { className: 'ab-muted' }, '分钟')),
          h(Row, { label: '每天最多' }, f.num('speakUp.maxPerDay', { min: 0 }), h('span', { className: 'ab-muted' }, '次')),
          h(Row, { label: '她醒着的时间', hint: '这段时间外不打扰你' }, f.num('speakUp.awakeFrom', { min: 0, max: 23 }), h('span', { className: 'ab-muted' }, '点到'), f.num('speakUp.awakeTo', { min: 1, max: 24 }), h('span', { className: 'ab-muted' }, '点')),
          h('div', { className: 'ab-flex', style: { marginTop: 10 } },
            h('span', { className: 'ab-muted ab-small' }, '今天已经找过你 ' + (st.speakUp.count || 0) + ' 次'),
            h('div', { className: 'ab-spacer' }),
            h(Btn, { small: true, onClick: async () => { const r = await post('/speakup/fire'); toast(r.message) } }, '立即向主人私聊搭话')),
        ),
        h(PurposePreview, { st, toast }),
      )
    }

    function PurposePreview({ st, toast }) {
      const [target, setTarget] = useState(st.config.speakUp.targets?.[0] || 'private:' + st.config.ownerQQ)
      const [data, setData] = useState(null)
      const seq = useRef(0)
      useEffect(() => () => { seq.current++ }, [])
      const reasons = { disabled: '未开启目的模式或已暂停', 'dry-run': '试运行中', quiet: '安静时段', active: '聊天仍活跃', quota: '今日额度已用完', cooldown: '仍在冷却', scheduled: '尚未到计划时间', 'no-material': '没有新的可用来源' }
      return h(Card, { title: '目的状态与预览', desc: '只读预览，不调用模型或发送消息；来源、目标和驱动均限于所选聊天和当前人格，候选只是待验证的假设。' },
        h(Row, { label: '目标聊天' }, h('input', { className: 'ab-input', value: target, onChange: e => { seq.current++; setTarget(e.target.value); setData(null) } }),
          h(Btn, { small: true, onClick: async () => { const request = ++seq.current; const r = await get('/purpose/preview?' + new URLSearchParams({ target })); if (request !== seq.current) return; setData(r); if (!r.ok) toast(r.message, 'err') } }, '查看预览')),
        data?.ok ? h('div', null,
          h('div', { className: 'ab-pills' }, h('span', { className: 'ab-pill' }, data.scope.chat + ' · ' + data.scope.persona),
            h('span', { className: 'ab-pill' }, data.decision.act ? '条件满足，等待调度' : (reasons[data.decision.reason] || data.decision.reason)),
            h('span', { className: 'ab-pill' }, '今日 ' + (data.quota.count || 0) + ' / ' + data.quota.maxPerDay)),
          h('p', { className: 'ab-small ab-muted' }, '驱动：' + Object.entries(data.drives || {}).map(([k,v]) => k + ' ' + v).join(' · ')),
          data.candidates.length ? data.candidates.map(c => h('div', { key: c.id, className: 'ab-li' },
            h('div', { className: 'body' }, h('b', null, c.action + ' · ' + c.need), ' · 归属 ' + c.owner + ' · 假设 ' + c.confidence,
              h('div', { className: 'ab-small' }, c.topic), h('div', { className: 'ab-small ab-muted' }, '来源 ' + c.sourceId + ' · 评分 ' + c.score)))) : h(Empty, { text: '没有新的有来源候选' }),
          data.last ? h('p', { className: 'ab-small ab-muted' }, '上次排队：' + data.last.state + ' · ' + data.last.sourceId) : null) : null)
    }

    const SOURCE = { tool: '她自己记的', auto: '每日整理', panel: '你加的', event: '她的经历', import: '导入的' }

    // Token 统计只读取账本；字段覆盖率用于区分真实的 0 和服务未返回。
    const TOKEN_METRICS = [
      { key: 'inputTokens', label: '输入', count: 'inputCallsWithUsage' },
      { key: 'outputTokens', label: '输出', count: 'outputCallsWithUsage' },
      { key: 'cachedTokens', label: '缓存', count: 'cachedCallsWithUsage' },
      { key: 'totalTokens', label: '已记录合计', count: 'callsWithUsage' },
    ]
    const TOKEN_INCOMPLETE_HINT = '包含明确标记 usageComplete=false、缺少输入，或聊天模型缺少输出的调用；缓存未返回不会单独计入。'
    const tokenNumber = n => n == null || !Number.isFinite(Number(n)) ? '未提供' : Number(n).toLocaleString('zh-CN')
    const tokenAxisNumber = n => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
    function tokenCell(row, metric) {
      const calls = Number(row?.calls) || 0, value = row?.[metric.key]
      if (value == null || !Number.isFinite(Number(value))) return { text: '未返回', value: '未返回', plot: null }
      if (!calls) return { text: tokenNumber(value), value: tokenNumber(value), plot: Number(value) }
      const count = row?.[metric.count]
      const covered = count == null ? null : Number(count)
      if (covered === 0 || (covered == null && Number(row.callsWithUsage) === 0)) return { text: '未返回', value: '未返回', plot: null }
      const partial = metric.key === 'totalTokens'
        ? Number(row.incompleteCalls) > 0
        : covered == null ? Number(row.incompleteCalls) > 0 : covered < calls
      if (partial) return { text: '已记录 ' + tokenNumber(value) + '（未完整返回）', value: tokenNumber(value), status: '已记录部分用量', plot: Number(value) === 0 ? null : Number(value) }
      return { text: tokenNumber(value), value: tokenNumber(value), plot: Number(value) }
    }
    function tokenDateValid(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
      const date = new Date(value + 'T00:00:00Z')
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    }
    const tokenFilterKey = f => JSON.stringify([f.range, f.range === 'custom' ? f.startDate : '', f.range === 'custom' ? f.endDate : '', f.chatId.trim()])
    function tokenDateLabel(value) {
      if (!Number.isFinite(Number(value))) return '—'
      const date = new Date(Number(value) + 8 * 60 * 60 * 1000)
      if (!Number.isFinite(date.getTime())) return '—'
      return String(date.getUTCFullYear()).padStart(4, '0') + '/' + String(date.getUTCMonth() + 1).padStart(2, '0') + '/' + String(date.getUTCDate()).padStart(2, '0')
    }

    function TokenTrend({ trend, metric }) {
      const [selected, setSelected] = useState(0)
      const points = trend?.points || []
      const [containerWidth, setContainerWidth] = useState(0), chartRef = useRef(null)
      useEffect(() => {
        const element = chartRef.current
        if (!element) return
        const measure = () => setContainerWidth(Math.max(0, Math.floor(element.clientWidth || 0)))
        measure()
        if (typeof ResizeObserver !== 'undefined') {
          const observer = new ResizeObserver(measure)
          observer.observe(element)
          return () => observer.disconnect()
        }
        if (typeof window !== 'undefined') {
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }
      }, [!!points.length])
      if (!points.length) return h(Empty, { text: '当前范围没有趋势数据' })
      const width = Math.max(560, containerWidth, Math.min(10000, points.length * 28 + 84)), height = 230
      const left = 66, right = 18, top = 18, bottom = 42, plotWidth = width - left - right, plotHeight = height - top - bottom
      const values = points.map(p => tokenCell(p, metric).plot)
      const max = Math.max(1, ...values.filter(v => v != null))
      const xAt = i => points.length === 1 ? left + plotWidth / 2 : left + i * plotWidth / (points.length - 1)
      const yAt = value => top + plotHeight * (1 - value / max)
      let path = '', joined = false
      values.forEach((v, i) => {
        if (v == null) { joined = false; return }
        path += (joined ? ' L ' : ' M ') + xAt(i).toFixed(2) + ' ' + yAt(v).toFixed(2)
        joined = true
      })
      const current = Math.max(0, Math.min(points.length - 1, selected)), point = points[current], pointCell = tokenCell(point, metric)
      const tickStep = Math.max(1, Math.ceil((points.length - 1) / Math.max(1, Math.floor(plotWidth / 100))))
      const move = e => {
        const rect = e.currentTarget.getBoundingClientRect()
        if (!rect.width || points.length === 1) { setSelected(0); return }
        const chartX = (e.clientX - rect.left) * width / rect.width
        setSelected(Math.max(0, Math.min(points.length - 1, Math.round((chartX - left) * (points.length - 1) / plotWidth))))
      }
      const keyDown = e => {
        let next = current
        if (e.key === 'ArrowLeft') next = Math.max(0, current - 1)
        else if (e.key === 'ArrowRight') next = Math.min(points.length - 1, current + 1)
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = points.length - 1
        else return
        e.preventDefault(); setSelected(next)
        const scroller = e.currentTarget?.parentElement
        if (scroller?.clientWidth) scroller.scrollLeft = Math.max(0, xAt(next) - scroller.clientWidth / 2)
      }
      return h('div', null,
        h('p', { className: 'ab-small ab-muted' }, '按' + (trend.granularity === 'month' ? '月' : '日') + '统计；曲线显示已记录值。未返回或无法确认的零值留空，缺失部分可能使实际值更高。可用鼠标或方向键查看各期。'),
        h('div', { className: 'ab-token-chart-scroll', ref: chartRef },
          h('svg', { width, height, viewBox: '0 0 ' + width + ' ' + height, role: 'img', tabIndex: 0,
            'aria-label': metric.label + ' Token 趋势，使用左右方向键查看各期，Home 和 End 跳至首末期', onMouseMove: move, onKeyDown: keyDown },
            h('title', null, metric.label + ' Token 趋势'),
            h('desc', null, '当前 ' + point.key + '：' + pointCell.text + '；共 ' + tokenNumber(point.calls) + ' 次调用。'),
            ...[0, 0.5, 1].map(f => h('g', { key: 'y' + f, 'aria-hidden': true },
              h('line', { x1: left, x2: width - right, y1: yAt(max * f), y2: yAt(max * f), stroke: 'var(--ab-line-2)', strokeWidth: 1 }),
              h('text', { x: left - 8, y: yAt(max * f) + 4, textAnchor: 'end', fill: 'var(--ab-sub)', fontSize: 11 }, tokenAxisNumber(max * f)))),
            ...points.map((p, i) => (i % tickStep === 0 || i === points.length - 1) && h('text', { key: 'x' + p.key, x: xAt(i), y: height - 16, textAnchor: i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle', fill: 'var(--ab-sub)', fontSize: 11, 'aria-hidden': true }, p.key)),
            path ? h('path', { d: path, fill: 'none', stroke: 'var(--ab-sea)', strokeWidth: 2, strokeLinejoin: 'round', 'aria-hidden': true }) : null,
            ...values.map((v, i) => v == null ? null : h('circle', { key: 'p' + points[i].key, cx: xAt(i), cy: yAt(v), r: i === current ? 4 : 2.5, fill: 'var(--ab-sea)', 'aria-hidden': true })),
            h('line', { x1: xAt(current), x2: xAt(current), y1: top, y2: height - bottom, stroke: 'var(--ab-sky)', strokeWidth: 1, strokeDasharray: '4 4', 'aria-hidden': true }))),
        h('p', { className: 'ab-token-chart-detail', 'aria-live': 'polite' }, point.key + ' · ' + metric.label + ' ' + pointCell.text + ' token · ' + tokenNumber(point.calls) + ' 次调用'),
        h('details', { style: { marginTop: 10 } }, h('summary', null, '查看趋势数据表'),
          h('div', { className: 'ab-token-table-wrap' },
            h('table', { className: 'ab-table ab-token-table' },
              h('thead', null, h('tr', null, h('th', { scope: 'col' }, trend.granularity === 'month' ? '月份' : '日期'), ...TOKEN_METRICS.map(m => h('th', { key: m.key, scope: 'col' }, m.label)), h('th', { scope: 'col' }, '调用'), h('th', { scope: 'col', title: TOKEN_INCOMPLETE_HINT }, '核心用量不完整'))),
              h('tbody', null, ...points.map(p => h('tr', { key: p.key }, h('th', { scope: 'row' }, p.key), ...TOKEN_METRICS.map(m => h('td', { key: m.key }, tokenCell(p, m).text)), h('td', null, tokenNumber(p.calls)), h('td', null, tokenNumber(p.incompleteCalls)))))))))
    }

    function TokenDashboard() {
      const initial = { range: '7d', startDate: '', endDate: '', chatId: '' }
      const [filters, setFilters] = useState(initial), [applied, setApplied] = useState(initial)
      const [data, setData] = useState(null), [status, setStatus] = useState('loading'), [error, setError] = useState('')
      const [metricKey, setMetricKey] = useState('totalTokens'), seq = useRef(0)
      const change = (key, value) => {
        if (filters[key] === value) return
        seq.current++
        setFilters(f => ({ ...f, [key]: value }))
        setData(null); setError(''); setStatus('idle')
      }
      const load = async selected => {
        const request = ++seq.current
        setData(null); setError('')
        if (selected.range === 'custom' && (!tokenDateValid(selected.startDate) || !tokenDateValid(selected.endDate))) {
          setStatus('idle'); setError('请选择有效的开始和结束日期。'); return
        }
        if (selected.range === 'custom' && selected.startDate > selected.endDate) {
          setStatus('idle'); setError('开始日期不能晚于结束日期。'); return
        }
        const query = new URLSearchParams({ range: selected.range })
        if (selected.range === 'custom') { query.set('startDate', selected.startDate); query.set('endDate', selected.endDate) }
        if (selected.chatId.trim()) query.set('chatId', selected.chatId.trim())
        setApplied({ ...selected }); setStatus('loading')
        try {
          const result = await get('/token-meter/dashboard?' + query.toString())
          if (request !== seq.current) return
          if (!result?.ok) { setStatus('error'); setError(result?.message || '读取 Token 统计失败'); return }
          setData(result); setStatus('ready')
        } catch (e) {
          if (request !== seq.current) return
          setStatus('error'); setError(e?.message || '读取 Token 统计失败')
        }
      }
      useEffect(() => { load(initial); return () => { seq.current++ } }, [])
      const modified = tokenFilterKey(filters) !== tokenFilterKey(applied)
      const metric = TOKEN_METRICS.find(m => m.key === metricKey) || TOKEN_METRICS[3]
      const totals = data?.totals, calls = Number(totals?.calls) || 0
      const countsKnown = totals && TOKEN_METRICS.slice(0, 3).every(m => totals[m.count] != null)
      const rangeOptions = [{ value: 'today', label: '今日' }, { value: '7d', label: '近 7 天' }, { value: '30d', label: '近 30 天' }, { value: 'all', label: '全部' }, { value: 'custom', label: '自定义' }]
      return h('div', { className: 'ab-grid' },
        h(Card, { title: 'Token 统计', className: 'ab-token-filters', desc: '只读统计当前账号的聊天模型（LLM）和向量模型（embedding）调用；其他服务用量可在「诊断」查看。按 UTC+8 计算，自定义结束日期包含当天。' },
          h(Row, { label: '时间范围' }, h('div', { className: 'ab-token-ranges', role: 'group', 'aria-label': 'Token 统计时间范围' },
            ...rangeOptions.map(o => h('button', { key: o.value, type: 'button', className: 'ab-btn sm', 'aria-pressed': filters.range === o.value, onClick: () => change('range', o.value) }, o.label)))),
          filters.range === 'custom' ? h(Row, { label: '自定义日期', hint: '包含起始日和结束日' },
            h('input', { className: 'ab-input', type: 'date', 'aria-label': '开始日期', value: filters.startDate, onChange: e => change('startDate', e.target.value) }),
            h('span', { className: 'ab-muted' }, '至'),
            h('input', { className: 'ab-input', type: 'date', 'aria-label': '结束日期', value: filters.endDate, onChange: e => change('endDate', e.target.value) })) : null,
          h(Row, { label: '聊天范围', hint: '留空为整个当前账号；例如 group:123456' },
            h('input', { className: 'ab-input wide', 'aria-label': 'Token 统计聊天范围', value: filters.chatId, placeholder: '整个当前账号', onChange: e => change('chatId', e.target.value) })),
          h('div', { className: 'ab-flex', style: { marginTop: 12 } },
            h('button', { type: 'button', className: 'ab-btn primary', onClick: () => load(filters) }, '应用筛选'),
            h('button', { type: 'button', className: 'ab-btn', disabled: modified, onClick: () => load(applied) }, '刷新'),
            status === 'idle' && !error ? h('span', { className: 'ab-small ab-muted', role: 'status' }, '筛选条件已更改，请点击应用筛选。') : null),
          error ? h('p', { className: 'ab-note err', role: 'alert' }, error) : null),
        status === 'loading' ? h(Card, null, h('div', { role: 'status', className: 'ab-muted' }, h('i', { className: 'ab-spin' }), ' 正在读取 Token 统计…')) : null,
        status === 'ready' && data ? h('div', { className: 'ab-grid' },
          h('div', { className: 'ab-small ab-muted' }, (data.range === 'all' ? '全部历史' : tokenDateLabel(data.from) + ' 至 ' + tokenDateLabel(Number(data.to) - 1)) + ' · 北京时间 · ' + (applied.chatId.trim() || '整个当前账号')),
          h('div', { className: 'ab-grid ab-g4' }, ...TOKEN_METRICS.map(m => {
            const cell = tokenCell(totals, m)
            return h('div', { key: m.key, className: 'ab-card ab-stat ab-token-stat', role: 'group', 'aria-label': m.label + ' token：' + cell.text },
              h('div', { className: 'l', 'aria-hidden': true }, m.label + ' token'),
              h('div', { className: 'n', 'aria-hidden': true }, cell.value),
              cell.status ? h('div', { className: 'ab-token-stat-status', 'aria-hidden': true }, cell.status) : null)
          })),
          h('div', { className: 'ab-note' },
            h('div', { title: TOKEN_INCOMPLETE_HINT }, '共 ' + tokenNumber(calls) + ' 次调用 · ' + tokenNumber(totals.callsWithUsage) + ' 次返回用量 · ' + tokenNumber(totals.incompleteCalls) + ' 次核心用量不完整'),
            countsKnown ? h('div', null, '字段返回覆盖：输入 ' + tokenNumber(totals.inputCallsWithUsage) + ' / ' + tokenNumber(calls) + ' · 输出 ' + tokenNumber(totals.outputCallsWithUsage) + ' / ' + tokenNumber(calls) + ' · 缓存 ' + tokenNumber(totals.cachedCallsWithUsage) + ' / ' + tokenNumber(calls)) : null,
            calls && Number(totals.callsWithUsage) === 0 ? h('div', null, '这些调用未返回用量，不能视为零用量。') : null,
            h('div', null, '合计只包含已返回的用量；未返回字段不计入。核心用量不完整包括明确标记不完整或缺少必要输入、输出，不含仅缓存未返回的调用。'),
            h('div', null, 'Embedding 的输入已含缓存，合计不会重复计算；因此输入、输出和缓存相加不一定等于合计。'),
            h('div', null, data.note || '只统计服务返回的用量；缺失值不计入合计。')),
          !calls ? h(Empty, { text: '当前范围尚无调用记录' }) : null,
          h(Card, { title: '按模型统计', desc: '未完整返回的字段只显示已记录值；模型名称缺失时显示 (unknown)。' },
            data.models?.length ? h('div', { className: 'ab-token-table-wrap' }, h('table', { className: 'ab-table ab-token-table' },
              h('thead', null, h('tr', null, h('th', { scope: 'col' }, '模型'), ...TOKEN_METRICS.map(m => h('th', { key: m.key, scope: 'col' }, m.label)), h('th', { scope: 'col' }, '调用'), h('th', { scope: 'col', title: TOKEN_INCOMPLETE_HINT }, '核心用量不完整'))),
              h('tbody', null, ...data.models.map(m => h('tr', { key: m.key }, h('th', { scope: 'row' }, m.key), ...TOKEN_METRICS.map(x => h('td', { key: x.key }, tokenCell(m, x).text)), h('td', null, tokenNumber(m.calls)), h('td', null, tokenNumber(m.incompleteCalls))))))) : h(Empty, { text: '当前范围没有模型记录' })),
          h(Card, { title: '用量趋势', right: h('div', { className: 'ab-token-ranges', role: 'group', 'aria-label': '趋势指标' },
            ...TOKEN_METRICS.map(m => h('button', { key: m.key, type: 'button', className: 'ab-btn sm', 'aria-pressed': metricKey === m.key, onClick: () => setMetricKey(m.key) }, m.label))) },
            h(TokenTrend, { trend: data.trend, metric }))) : null)
    }

    function Diagnostics({ toast }) {
      const [data,setData]=useState(null),[requests,setRequests]=useState([]),[decisions,setDecisions]=useState([]),[timeline,setTimeline]=useState(null),[chatId,setChatId]=useState(''),[error,setError]=useState(''),[latency,setLatency]=useState(null),[replay,setReplay]=useState(null),[refresh,setRefresh]=useState(0)
      const load=useCallback(async()=>{
        const qs='?'+new URLSearchParams({chatId})
        const [summary,req,dec,lat]=await Promise.all([get('/diagnostics/summary'),get('/diagnostics/requests'+qs),get('/diagnostics/decisions'+qs),get('/diagnostics/latencies'+qs)])
        const bad=[summary,req,dec,lat].find(r=>!r.ok);if(bad){setError(bad.message);return}
        setError('');setData(summary);setRequests(req.list);setDecisions(dec.list);setLatency(lat);setRefresh(v=>v+1)
      },[chatId])
      useEffect(()=>{load()},[load])
      useEffect(()=>{setTimeline(null);setReplay(null)},[chatId])
      const replayAt=async selector=>{const r=await get('/diagnostics/replay?'+new URLSearchParams(selector));if(r.ok)setReplay(r);else toast(r.message,'err')}
      const ms=v=>v==null?'无样本':Math.round(v).toLocaleString()+' ms'
      const download=async()=>{const r=await get('/diagnostics/export');if(!r.ok)return toast(r.message,'err');const url=URL.createObjectURL(new Blob([JSON.stringify(r.report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='aurabot-diagnostics-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
      return h('div',{className:'ab-grid'},error?h('div',{className:'ab-note err',role:'alert'},error):null,
        h(Card,{title:'运行诊断',desc:'追踪请求、提供方尝试和 QQ 发送回执。导出内容不包含聊天正文和服务密钥。',right:h('div',{className:'ab-flex'},h(Btn,{small:true,onClick:load},'刷新'),h(Btn,{small:true,onClick:download},'导出诊断'))},
          data?h(Fragment,null,h('div',{className:'ab-pills'},h('span',{className:'ab-pill'},'数据库 v'+data.schemaVersion),h('span',{className:'ab-pill'},'等待媒体 '+data.queue.pendingMedia),h('span',{className:'ab-pill'},'待提炼范围 '+data.queue.pendingMemory),h('span',{className:'ab-pill'},'事件循环 P95 '+data.eventLoop.p95Ms+' ms')),
            h('div',{className:'ab-section-title'},'任务与调用'),h('div',{className:'ab-pills'},...data.jobs.map(x=>h('span',{key:x.state,className:'ab-pill'},x.state+' '+x.n))),h('p',{className:'ab-muted ab-small'},data.billingNote),h('div',{className:'ab-flex'},...data.billing.map(x=>h('span',{key:x.billing,className:'ab-pill'},x.billing+' '+x.n))),
            ...data.modules.filter(m=>m.error||m.errors?.length).map(m=>h('div',{key:m.id,className:'ab-note warn'},m.id+'：'+(m.error||m.errors[0]?.message))),
            h('details',null,h('summary',null,'迁移与宿主能力'),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},JSON.stringify({migration:data.migration,host:data.host,limitations:data.limitations},null,2)))):h(Empty,{text:'正在读取诊断…'})),
        h(Card,{title:'请求时间线'},h(Row,{label:'按聊天过滤',hint:'留空显示当前账号；例如 group:123456'},h('input',{className:'ab-input wide','aria-label':'诊断聊天范围',value:chatId,onChange:e=>setChatId(e.target.value)})),
          ...requests.map(r=>h('div',{key:r.id,className:'ab-li'},h('div',{className:'body'},r.chatId+' · '+r.actorId+' · '+r.state,h('div',{className:'ab-small ab-muted'},r.id+' · '+new Date(r.createdAt).toLocaleString())),h(Btn,{small:true,onClick:async()=>{const result=await get('/diagnostics/timeline?id='+encodeURIComponent(r.id));if(result.ok)setTimeline(result);else toast(result.message,'err')}},'查看链路'),h(Btn,{small:true,onClick:()=>replayAt({requestId:r.id})},'只读回放'))),
          !requests.length?h(Empty,{text:'当前范围还没有请求'}):null,
          timeline?h('div',{className:'ab-card'},h('b',null,timeline.request.id),...timeline.events.map(e=>h('div',{key:e.id+e.kind,className:'ab-li'},h('div',{className:'meta'},new Date(e.at).toLocaleTimeString()),h('div',{className:'body'},e.kind+' · '+e.state,h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12}},JSON.stringify(e.info,null,2)))))):null),
        h(Card,{title:'请求耗时',desc:'从本机收到消息开始计时；确认回复以 QQ 回执为准。缺少证据的样本不计入分位。当前窗口最多 40 条请求。'},
          ...Object.entries({firstDecision:'首次决策',firstConfirmedReply:'首次确认回复',finalDelivery:'最终交付'}).map(([key,label])=>{const m=latency?.metrics?.[key];return h('div',{className:'ab-li',key},h('b',null,label),h('div',{className:'body'},'P50 '+ms(m?.p50Ms)+' · P95 '+ms(m?.p95Ms)),h('span',{className:'ab-small ab-muted'},(m?.sampleCount||0)+' 个样本 · '+(m?.missingCount||0)+' 条缺失'))}),
          latency?.window?.truncated?h('p',{className:'ab-muted ab-small'},'仅统计最近窗口；更早的请求未包含在内。'):null),
        h(Card,{title:'为何回应或沉默'},...decisions.map(d=>h('details',{key:d.id,style:{marginBottom:10}},h('summary',null,d.chatId+' · '+new Date(d.at).toLocaleString()+' · '+(d.decision?.reply?'回应':'沉默')+'：'+(d.decision?.reason||'记录不完整')),h('pre',{style:{whiteSpace:'pre-wrap'}},JSON.stringify({messageId:d.messageId,mentioned:d.mentioned,memoryScore:d.memoryScore,policy:d.policy},null,2)),h(Btn,{small:true,onClick:()=>replayAt({eventId:d.id})},'只读回放')))),
        replay?h(Card,{title:'只读回放',desc:'使用当时保存的输入重算基础群聊策略；不调用模型、工具或 QQ。扩展 Hook 与参与限制后的最终决定另列。'},
          ...(replay.events||[]).map(e=>h('div',{key:e.id,className:'ab-card'},h('b',null,e.kind+' · '+new Date(e.at).toLocaleString()),h('p',null,'记录结果：'+(e.recorded.decision?.reason||'未记录决策')),
            h('p',null,e.recomputation.status==='recomputed'?'基础策略：'+e.recomputation.decision.reason+' · '+(e.recomputation.matchesRecordedBase===true?'与历史基础决定一致':e.recomputation.matchesRecordedBase===false?'与历史基础决定不同':'缺少历史基础决定用于比较'):'不可重算：'+(e.recomputation.missing||[e.recomputation.status]).join('、')))),
          !replay.events?.length?h(Empty,{text:'没有可关联的决策事件；可展开账本查看已持久化的记录。'}):null,
          h('details',null,h('summary',null,'版本、未知项与当前账本'),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},JSON.stringify(replay,null,2)))):null,
        h(Card,{title:'扩展 Hook 耗时与错误',desc:'合作式超时和结构检查不构成第三方 JavaScript 沙箱。'},
          ...(data?.hooks?.stats||[]).map(x=>h('div',{key:x.module+':'+x.event,className:'ab-li'},h('b',null,x.module),h('div',{className:'body'},x.event),h('span',{className:'ab-small'},x.calls+' 次 · 失败 '+x.failures+' · 最慢 '+x.maxMs+' ms')))),
        h(UsageCard,{chatId,requestId:timeline?.request?.id,refresh}))
    }

    function UsageCard({chatId,requestId,refresh}) {
      const [data,setData]=useState(null),[error,setError]=useState(''),[selected,setSelected]=useState(false)
      useEffect(()=>{let active=true;get('/diagnostics/usage?'+new URLSearchParams({chatId:chatId||'',...(selected&&requestId?{requestId}:{})})).then(r=>{if(!active)return;if(r.ok){setData(r);setError('')}else setError(r.message)});return()=>{active=false}},[chatId,requestId,selected,refresh])
      const num=v=>v==null?'未提供':Number(v).toLocaleString()
      return h(Card,{title:'模型与服务用量',desc:data?.note||'按当前账号或所选请求查看调用账本。'},
        requestId?h(Row,{label:'仅所选请求',hint:requestId},h(Switch,{on:selected,onChange:setSelected})):null,
        error?h('div',{className:'ab-note err'},error):null,
        ...(data?.totals||[]).map(x=>h('div',{key:x.service,className:'ab-li'},h('b',null,x.service),h('div',{className:'body'},x.calls+' 次 · 输入 '+num(x.inputTokens)+' token · 输出 '+num(x.outputTokens)+' token · 缓存 '+num(x.cachedTokens)+' token · 搜索额度 '+num(x.credits)),h('span',{className:'ab-small ab-muted'},x.unknownAmountCalls+' 次金额未知'))),
        !data?.totals?.length?h(Empty,{text:'当前范围尚无调用记录'}):null,
        ...(data?.amounts||[]).map(x=>h('p',{key:x.currency},'服务返回金额：'+num(x.amount)+' '+x.currency)),
        h('details',null,h('summary',null,'最近调用记录'),...(data?.items||[]).map(x=>h('div',{key:x.id,className:'ab-li'},h('div',{className:'meta'},new Date(x.startedAt).toLocaleString()),h('div',{className:'body'},x.service+' · '+(x.model||'服务未提供型号')+' · 传输 '+x.status+' · 业务 '+(x.businessStatus||'未报告'),x.businessError?h('div',{className:'ab-note err'},x.businessError):null,h('div',{className:'ab-small'},(x.chatId||'后台')+' · '+(x.requestId||'未绑定单个请求')+' · '+num(x.durationMs)+' ms'))))))
    }

    function SearchPanel({ st, draft, setDraft, toast, go }) {
      const f = useField(draft, setDraft), [scope, setScope, isCurrent] = useViewingScope({account: st.config.botQQ, chat: 'private:' + st.config.ownerQQ, persona: ''})
      const [query, setQuery] = useState(''), [urls, setUrls] = useState(''), [entity, setEntity] = useState({name:'',work:'',version:'',kind:'fictional'})
      const [result, setResult] = useState(null), [history, setHistory] = useState([]), [busy, setBusy] = useState(false), [error, setError] = useState('')
      const dirty = JSON.stringify(draft.search) !== JSON.stringify(st.config.search)
      const load = useCallback(async()=>{if(!isCurrent())return;const r=await get('/search/history?chatId='+encodeURIComponent(scope.chat));if(!isCurrent())return;if(r.ok)setHistory(r.list);else setError(r.message)},[scope])
      useEffect(()=>{setResult(null);setError('');load()},[load])
      const run = async(path,body)=>{
        if(!isCurrent())return
        setBusy(true);setError('')
        try { const r=await post(path,{...body,chatId:scope.chat});if(!isCurrent())return;if(!r.ok){setError(r.message);return r};if(r.result)setResult(r.result);await load();if(isCurrent())return r } finally {if(isCurrent())setBusy(false)}
      }
      return h('div',{className:'ab-grid'},
        h(Card,{title:'网页与参考图搜索',right:f.sw('search.enabled'),desc:'搜索保留来源和抓取时间。摘要、原文和参考图审核结果分别显示；网页内容不会自动成为记忆。设置修改后先保存。'},
          h(Row,{label:'Tavily 服务地址'},f.text('search.baseUrl',{size:'wide'})),
          h(Row,{label:'API Key'},f.text('search.apiKey',{type:'password',placeholder:st.config.search?.apiKeySet?'已保存，留空保留':'填写 Tavily API Key'})),
          h(Row,{label:'每次结果数'},f.range('search.maxResults',1,20,1,v=>v+' 条')),
          h(Row,{label:'每日请求上限',hint:'包括搜索、提取与来源验证请求'},f.num('search.maxRequestsPerDay',{min:1,max:10000})),
          h(Row,{label:'视觉审核参考图',hint:'额外使用视觉模型检查对应性、清晰度、遮挡、拼图和水印'},f.sw('search.visionReview'))),
        h(ScopePicker,{st,scope,persona:false,onChange:next=>{setScope(next);setResult(null);setHistory([]);setError('');setBusy(false);setQuery('');setUrls('');setEntity({name:'',work:'',version:'',kind:'fictional'})}}),
        h(Card,{title:'搜索工作台',desc:'先查资料，或填写角色与作品寻找参考图。每个请求最多两轮搜索；仍有歧义时保留待确认。'},
          dirty?h('div',{className:'ab-note warn'},'搜索设置尚未保存，保存后再测试。'):null,
          error?h('div',{className:'ab-note err',role:'alert'},error):null,
          h(Row,{label:'查询内容'},h('input',{className:'ab-input wide','aria-label':'搜索内容',value:query,onChange:e=>setQuery(e.target.value)})),
          h(Btn,{small:true,disabled:busy||dirty||!query.trim(),onClick:()=>run('/search/query',{query})},busy?'处理中…':'搜索网页'),
          h(Row,{label:'网页地址',hint:'一行一个，读取公开网页'},h('textarea',{className:'ab-textarea','aria-label':'网页地址',value:urls,onChange:e=>setUrls(e.target.value)})),
          h(Btn,{small:true,disabled:busy||dirty||!urls.trim(),onClick:()=>run('/search/extract',{urls:urls.split('\n').map(x=>x.trim()).filter(Boolean),query:query||undefined})},'提取正文'),
          h('div',{className:'ab-section-title'},'参考图目标'),
          ...[['name','角色 / 物体名称'],['work','作品 / 来源'],['version','造型 / 版本']].map(([key,label])=>h(Row,{key,label},h('input',{className:'ab-input wide','aria-label':label,value:entity[key],onChange:e=>setEntity({...entity,[key]:e.target.value})}))),
          h(Row,{label:'目标类别'},h(Select,{value:entity.kind,onChange:v=>setEntity({...entity,kind:v}),options:[{value:'fictional',label:'虚构角色'},{value:'object',label:'物体'},{value:'public-person',label:'公众人物（人工确认）'}]})),
          h(Btn,{small:true,disabled:busy||dirty||!entity.name.trim()||!query.trim(),onClick:()=>run('/search/references',{query,entity})},'搜索并验证参考来源')),
        result?h(Card,{title:result.query||'搜索结果',desc:result.expired?'缓存已过期，请重新搜索。':'抓取时间：'+new Date(result.fetchedAt||result.createdAt).toLocaleString()},
          h('div',{className:'ab-note'},'外部资料仅作参考。引用时核对来源；参考图片需通过来源、文件与视觉或人工审核。'),
          ...(result.sources||[]).map(source=>h('div',{className:'ab-card',key:source.id,style:{marginTop:8}},h('a',{href:source.url,target:'_blank',rel:'noopener noreferrer'},source.title||source.url),h('div',{className:'ab-small ab-muted'},source.pageRead?'已读取正文':'仅搜索摘要'),h('p',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},(source.content||source.snippet||'').slice(0,4000)))),
          ...(result.candidates||[]).map(candidate=>h(ReferenceCandidate,{key:result.id+candidate.id+candidate.status,scope,resultId:result.id,candidate,busy,run,onUse:async()=>{
            const r=await run('/search/reference/materialize',{resultId:result.id,candidateId:candidate.id});if(!r?.ok)return
            try {sessionStorage.setItem('aurabot.imageReference',JSON.stringify({account:scope.account,chatId:scope.chat,reference:r.reference}))} catch {toast('浏览器不能暂存参考图','err');return};go('imagegen')
          }})),
          ...(result.failures||[]).map((failure,i)=>h('div',{key:i,className:'ab-note warn'},(failure.url||'')+' · '+(failure.message||failure.code)))):null,
        h(Card,{title:'本聊天搜索记录',right:h(Btn,{small:true,onClick:load},'刷新记录')},history.length?history.map(item=>h('div',{className:'ab-li',key:item.id},h('div',{className:'body'},h('b',null,item.query||item.type),h('div',{className:'ab-small ab-muted'},new Date(item.createdAt).toLocaleString()+' · '+item.status+' · 来源 '+item.sourceCount+' · 候选 '+item.candidateCount)),h(Btn,{small:true,onClick:async()=>{if(!isCurrent())return;const r=await get('/search/result?'+new URLSearchParams({chatId:scope.chat,id:item.id}));if(!isCurrent())return;if(r.ok)setResult(r.result);else toast(r.message,'err')}},'查看'))):h(Empty,{text:'还没有搜索记录'})))
    }
    function ReferenceCandidate({ scope, resultId, candidate, busy, run, onUse }) {
      const [review,setReview]=useState({matchesTarget:false,clear:false,unobstructed:false,singleSubject:false,noWatermark:false,reason:''})
      const ready=candidate.download?.status==='ready'&&candidate.sourceCheck?.status==='verified'
      return h('div',{className:'ab-card',style:{marginTop:12}},
        h('div',{className:'ab-flex'},ready?h('img',{src:API+'/search/reference/preview?'+new URLSearchParams({chatId:scope.chat,resultId,candidateId:candidate.id}),alt:candidate.description||'参考候选',style:{maxWidth:240,maxHeight:220,objectFit:'contain',borderRadius:10}}):null,
          h('div',{className:'body'},h('b',null,candidate.description||'参考候选'),h('div',null,candidate.status==='verified'?'已审核，可用于生成':candidate.status==='rejected'?'已拒绝':'等待确认'),candidate.sourcePageUrl?h('a',{href:candidate.sourcePageUrl,target:'_blank',rel:'noopener noreferrer'},'来源页面'):null,h('p',{className:'ab-small ab-muted'},candidate.failure?.message||candidate.visualReview?.reason||''))),
        ready&&candidate.status!=='verified'?h('div',{className:'ab-grid'},...Object.entries({matchesTarget:'与所填角色、作品和版本一致',clear:'图像清晰',unobstructed:'主体没有严重遮挡',singleSubject:'不是多张图片拼接',noWatermark:'没有明显水印'}).map(([key,label])=>h('label',{key},h('input',{type:'checkbox',checked:review[key],onChange:e=>setReview({...review,[key]:e.target.checked})}),' '+label)),h('input',{className:'ab-input wide','aria-label':'参考图审核依据',placeholder:'填写审核依据',value:review.reason,onChange:e=>setReview({...review,reason:e.target.value})}),h(Btn,{small:true,disabled:busy||!review.reason.trim(),onClick:()=>run('/search/reference/confirm',{resultId,candidateId:candidate.id,review})},'保存人工审核')):null,
        candidate.status==='verified'?h(Btn,{small:true,kind:'primary',disabled:busy,onClick:onUse},'用于生图'):null)
    }

    function BackgroundProgress({ state, onResume, busy }) {
      if (!state) return null
      const reason = { PLUGIN_DISABLED: '插件已停用', SCOPE_DISABLED: '聊天已停用', MEMORY_DISABLED: '记忆已停用', LEARNING_DISABLED: '自动学习已停用', MOOD_DISABLED: '心情判断已停用' }[state.blockedReason] || state.blockedReason
      return h('div', { className: 'ab-note', style: { marginTop: 8 } },
        h('div', null, reason || (state.paused ? '连续失败，已暂停' : state.running ? '正在处理' : state.nextAttemptAt > Date.now() ? '失败退避中' : '等待下一批'), ' · 连续失败 ' + (state.failures || 0)),
        state.lastError || state.pauseReason ? h('div', { className: 'ab-small' }, state.lastError || state.pauseReason) : null,
        state.nextAttemptAt > Date.now() && !state.paused ? h('div', { className: 'ab-small' }, '最早重试：' + new Date(state.nextAttemptAt).toLocaleString()) : null,
        state.batchLimit ? h('div', { className: 'ab-small' }, '缩批上限 ' + state.batchLimit + ' 条' + (state.charLimit ? ' / ' + state.charLimit + ' 字' : '')) : null,
        state.lastCallId ? h('code', { className: 'ab-small' }, state.lastCallId) : null,
        state.paused && onResume ? h(Btn, { small: true, disabled: busy || state.running || !!state.blockedReason, onClick: onResume }, '恢复后台处理') : null)
    }

    function Mood({ st, draft, setDraft, toast }) {
      const f=useField(draft,setDraft),[scope,setScope,isCurrent]=useViewingScope({account:st.config.botQQ,chat:'private:'+st.config.ownerQQ,persona:st.config.persona.current}),[mood,setMood]=useState(null),[delta,setDelta]=useState(0),[reason,setReason]=useState(''),[error,setError]=useState('')
      const load=useCallback(async()=>{if(!isCurrent())return;const r=await get('/mood/state?'+memoryQuery(scope));if(!isCurrent())return;if(r.ok){setMood(r);setError('')}else setError(r.message)},[scope])
      useEffect(()=>{setMood(null);load()},[load])
      const act=async(path,body)=>{if(!isCurrent())return;const r=await post(path,{...scope,expectedRevision:mood?.revision,...body});if(!isCurrent())return;if(!r.ok)return toast(r.message,'err');toast('已保存');await load()}
      return h('div',{className:'ab-grid'},h(ScopePicker,{st,scope,requirePersona:true,onChange:next=>{setScope(next);setMood(null);setDelta(0);setReason('');setError('')}}),
        h(Card,{title:'心情设置（全局）',right:f.sw('mood.enabled'),desc:'本卡开关和参数全局生效；下方心情记录按聊天和人设分别保存。情绪影响语气；明确请求和已接受的任务照常处理。'},
          h(Row,{label:'抽象基线'},f.range('mood.baseline',30,80,1,v=>String(v))),
          h(Row,{label:'恢复速度',hint:'情绪半衰期'},f.range('mood.halfLifeHours',0.5,24,0.5,v=>v+' 小时')),
          h(Row,{label:'模型判断情绪',hint:'开启后受调用间隔和后台预算限制'},f.sw('mood.judge'))),
        h(Card,{title:'当前范围心情',right:h(Btn,{small:true,onClick:load},'刷新')},error?h('div',{className:'ab-note err'},error):null,
          h(BackgroundProgress,{state:mood?.judgment,onResume:()=>act('/mood/resume',{})}),
          mood?h(Fragment,null,h('div',{className:'ab-flex'},h('b',null,mood.label),h('span',null,mood.value+' / 100 · v'+mood.revision)),h('div',{className:'ab-mood'},h('i',{style:{width:mood.value+'%'}})),h('p',null,mood.reason||'暂无原因'),h(Row,{label:'调整数值'},h('input',{className:'ab-input sm',type:'number',min:-100,max:100,value:delta,'aria-label':'心情调整数值',onChange:e=>setDelta(Number(e.target.value))})),h(Row,{label:'原因'},h('input',{className:'ab-input wide',value:reason,'aria-label':'心情调整原因',onChange:e=>setReason(e.target.value)})),h('div',{className:'ab-flex'},h(Btn,{small:true,disabled:!reason.trim()||!delta,onClick:()=>act('/mood/nudge',{delta,reason})},'保存调整'),h(Btn,{small:true,onClick:()=>act('/mood/reset',{})},'恢复基线')),h('div',{className:'ab-section-title'},'变化记录'),...mood.history.map((r,i)=>h('div',{key:i,className:'ab-li'},h('span',{className:'meta'},new Date(r.at).toLocaleString()),h('div',{className:'body'},r.from+' → '+r.to+' · '+r.reason)))):null))
    }

    const LEARNING_STATES={pending:'待审核',approved:'已批准',disabled:'已停用',deleted:'已删除'}
    function Learning({st,draft,setDraft,toast}) {
      const f=useField(draft,setDraft),[scope,setScope,isCurrent]=useViewingScope({account:st.config.botQQ,chat:'private:'+st.config.ownerQQ,persona:st.config.persona.current}),[kind,setKind]=useState('expression'),[status,setStatus]=useState(''),[items,setItems]=useState([]),[queues,setQueues]=useState([]),[budget,setBudget]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[creating,setCreating]=useState(false)
      const seq=useRef(0),load=useCallback(async()=>{if(!isCurrent())return;const id=++seq.current;const [r,q]=await Promise.all([get('/learning/items?'+memoryQuery(scope,{kind,status,includeDeleted:'true'})),get('/learning/status?'+memoryQuery(scope))]);if(id!==seq.current||!isCurrent())return;if(!r.ok||!q.ok){setError(r.message||q.message);return}setItems(r.items);setQueues(q.queues);setBudget(q.budget);setError('')},[scope,kind,status])
      useEffect(()=>{setItems([]);setCreating(false);load();return()=>{seq.current++}},[load])
      const act=async(path,body={})=>{if(!isCurrent())return;setBusy(true);try{const r=await post('/learning/'+path,{...scope,...body});if(!isCurrent())return;if(!r.ok)toast(r.message||r.code,'err');else{toast(r.message||'已保存');await load()}if(isCurrent())return r}catch(e){if(isCurrent())toast(e.message,'err')}finally{if(isCurrent())setBusy(false)}}
      return h('div',{className:'ab-grid'},h(ScopePicker,{st,scope,requirePersona:true,onChange:next=>{setScope(next);seq.current++;setItems([]);setQueues([]);setBudget(null);setCreating(false);setError('');setBusy(false)}}),
        h(Card,{title:'表达与黑话设置（全局）',right:f.sw('learning.enabled'),desc:'本卡总开关、自动学习和使用开关全局生效，不随查看范围切换；启用聊天仍由「权限」allow 控制。学习只生成待审候选；批准后才允许使用有效来源。修改后点页面底部保存。'},
          h(Row,{label:'自动学习'},f.sw('learning.learnEnabled')),h(Row,{label:'使用已批准内容'},f.sw('learning.useEnabled')),
          h(Row,{label:'表达习惯'},h('span',null,'学习'),f.sw('learning.learnExpressions'),h('span',null,'使用'),f.sw('learning.useExpressions')),
          h(Row,{label:'群内黑话'},h('span',null,'学习'),f.sw('learning.learnJargon'),h('span',null,'使用'),f.sw('learning.useJargon')),
          h(Row,{label:'允许从私聊学习',hint:'默认仅学习群聊；开启后私聊仍按聊天隔离'},f.sw('learning.allowPrivate')),
          h(Row,{label:'每日模型调用上限',hint:'与心情判断共用；0 表示不限日调用次数，并发和失败退避仍生效'},f.num('learning.maxCallsPerDay',{min:0,max:1000000})),
          budget?h('div',{className:'ab-note'},'今日已调用 '+budget.calls+' 次 · '+(budget.maxCallsPerDay===0?'不限日调用次数':'每日上限 '+budget.maxCallsPerDay+' 次')+' · 正在运行 '+budget.active+' / '+budget.maxConcurrent):null,
          h(Row,{label:'证据有效期'},f.num('learning.maxAgeDays',{min:1,max:90}),h('span',null,'天')),
          h(Row,{label:'至少不同说话者'},f.num('learning.minAuthors',{min:2,max:10})),h(Row,{label:'至少证据条数'},f.num('learning.minEvidence',{min:2,max:20}))),
        h(Card,{title:'审核工作台',right:h(Btn,{small:true,disabled:busy,onClick:load},'刷新')},error?h('div',{className:'ab-note err',role:'alert'},error):null,
          h('div',{className:'ab-flex'},h(Select,{value:kind,onChange:setKind,options:[{value:'expression',label:'表达习惯'},{value:'jargon',label:'黑话词典'}]}),h(Select,{value:status,onChange:setStatus,options:[{value:'',label:'全部状态'},...Object.entries(LEARNING_STATES).map(([value,label])=>({value,label}))]}),h(Btn,{small:true,disabled:busy,onClick:()=>setCreating(!creating)},creating?'取消新增':'新增有证据的条目'),h(Btn,{small:true,disabled:busy||JSON.stringify(draft.learning)!==JSON.stringify(st.config.learning),onClick:()=>act('run',{kind})},'提炼当前队列')),
          creating?h(LearningEditor,{key:JSON.stringify(scope)+':'+kind,kind,scope,busy,onSave:async data=>{const r=await act('create',{kind,data});if(r?.ok&&isCurrent())setCreating(false)}}):null,
          ...items.map(item=>h(LearningRecord,{key:JSON.stringify(scope)+':'+item.id+':'+item.revision,item,scope,act,busy,toast})),!items.length?h(Empty,{text:'当前范围没有条目；消息积累后可学习，也可手工引用证据建立待审条目'}):null),
        h(Card,{title:'提炼进度'},...queues.map(q=>h('div',{key:q.kind,className:'ab-card',style:{marginTop:8}},h('b',null,q.kind==='expression'?'表达习惯':'黑话词典'),h(BackgroundProgress,{state:q,busy,onResume:()=>act('resume',{kind:q.kind})}),h('p',null,(q.running?'处理中':'等待下一批')+' · 待处理 '+q.queued+' 条 · 已处理到消息序号 '+q.processedSeq),q.lastAttemptAt?h('div',{className:'ab-muted ab-small'},'上次尝试 '+new Date(q.lastAttemptAt).toLocaleString()+' · '+({done:'完成',no_info:'没有新信息',failed:'失败待重试',stale:'中断待恢复',running:'处理中'}[q.outcome]||'尚未运行')):null,q.lastError?h('div',{className:'ab-note err'},q.lastError):null,q.overflow?h('div',{className:'ab-note warn'},'队列容量不足；仍保留消息区间 '+q.overflow.from+'–'+q.overflow.to+' 等待补入'):null,q.nextAttemptAt>Date.now()?h('p',{className:'ab-muted ab-small'},'下次可尝试 '+new Date(q.nextAttemptAt).toLocaleString()):null))))
    }
    function LearningEditor({kind,scope,item,busy,onSave}) {
      const [data,setData]=useState(item?{...item,aliases:(item.aliases||[]).join('、'),evidenceMessageIds:(item.evidenceMessageIds||[]).join('\n')}:{situation:'',expression:'',term:'',aliases:'',meaning:'',meaningState:'uncertain',confidence:0.5,evidenceMessageIds:''})
      const set=(k,v)=>setData({...data,[k]:v}),fields=kind==='expression'?[['expression','表达形式'],['situation','适用情境']]:[['term','词条'],['aliases','别名（顿号分隔）'],['meaning','候选含义']]
      const submit=()=>{const out={confidence:Number(data.confidence),evidenceMessageIds:data.evidenceMessageIds.split(/[\n,，]/).map(s=>s.trim()).filter(Boolean)};for(const [key] of fields)out[key]=key==='aliases'?data[key].split(/[、,，\n]/).map(s=>s.trim()).filter(Boolean):data[key];if(kind==='jargon')out.meaningState=data.meaningState;onSave(out)}
      return h('div',{className:'ab-card',style:{marginTop:10}},...fields.map(([key,label])=>h(Row,{key,label},h('input',{className:'ab-input wide','aria-label':label,value:data[key],disabled:!!item&&['expression','term'].includes(key),onChange:e=>set(key,e.target.value)}))),
        kind==='jargon'?h(Row,{label:'含义状态'},h(Select,{value:data.meaningState,onChange:v=>set('meaningState',v),options:[{value:'unknown',label:'未知'},{value:'uncertain',label:'待确认'},{value:'confirmed',label:'已确认'},{value:'rejected',label:'已否定'}]})):null,
        h(Row,{label:'置信度'},h('input',{className:'ab-input sm',type:'number',min:0,max:1,step:0.1,value:data.confidence,onChange:e=>set('confidence',e.target.value)})),
        h(Row,{label:'来源消息 ID',hint:'一行一个主库消息 ID；表达或词形必须实际出现在证据中'},h('textarea',{className:'ab-textarea','aria-label':'学习来源消息 ID',value:data.evidenceMessageIds,onChange:e=>set('evidenceMessageIds',e.target.value)})),
        h(LearningSourcePicker,{scope,kind,selected:data.evidenceMessageIds.split(/[\n,，]/).map(s=>s.trim()).filter(Boolean),onChange:ids=>set('evidenceMessageIds',ids.join('\n'))}),
        h(Btn,{small:true,kind:'primary',disabled:busy||!data.evidenceMessageIds.trim(),onClick:submit},'保存为待审核'))
    }
    function LearningSourcePicker({scope,kind,selected,onChange}) {
      const [q,setQ]=useState(''),[result,setResult]=useState(null),[busy,setBusy]=useState(false),seq=useRef(0)
      const load=async()=>{const id=++seq.current;setBusy(true);const r=await get('/learning/sources?'+memoryQuery(scope,{kind,q,limit:50}));if(id!==seq.current)return;setResult(r);setBusy(false)}
      useEffect(()=>{load();return()=>{seq.current++}},[scope.account,scope.chat,scope.persona,kind])
      return h('details',{open:true,style:{marginBottom:12}},h('summary',null,'从当前聊天选择证据'),
        h('div',{className:'ab-flex'},h('input',{className:'ab-input wide','aria-label':'筛选学习证据',value:q,onChange:e=>setQ(e.target.value),placeholder:'按内容或说话人查找'}),h(Btn,{small:true,disabled:busy,onClick:load},busy?'查找中…':'查找证据')),
        result?.ok===false?h('div',{className:'ab-note err'},result.message):null,
        ...(result?.items||[]).map(e=>h('label',{key:e.id,className:'ab-li'},h('input',{type:'checkbox',checked:selected.includes(e.id),onChange:ev=>onChange(ev.target.checked?[...selected,e.id]:selected.filter(id=>id!==e.id))}),h('div',{className:'body'},e.text,h('div',{className:'ab-muted ab-small'},(e.authorName||e.authorId)+' · '+new Date(e.receivedAt).toLocaleString())))),
        result?.ok&&!result.items?.length?h('p',{className:'ab-muted'},'当前范围没有可选的真实聊天证据'):null,result?.truncated?h('p',{className:'ab-muted ab-small'},'仅显示最近匹配的证据；可缩小查找范围。'):null)
    }
    function LearningRecord({item,scope,act,busy,toast}) {
      const [editing,setEditing]=useState(false),[details,setDetails]=useState(null)
      const b={id:item.id,expectedRevision:item.revision},load=async()=>{const [e,a]=await Promise.all([get('/learning/evidence?'+memoryQuery(scope,{id:item.id})),get('/learning/audit?'+memoryQuery(scope,{id:item.id}))]);if(!e.ok||!a.ok)return toast(e.message||a.message,'err');setDetails({evidence:e.items,audit:a.items})}
      return h('div',{className:'ab-card',style:{marginTop:12}},h('div',{className:'ab-flex'},h('b',null,item.expression||item.term),h('span',{className:'ab-pill'},LEARNING_STATES[item.status]),h('span',{className:'ab-muted ab-small'},'v'+item.revision+' · '+item.evidenceCount+' 条证据 · '+item.authorCount+' 位说话者')),
        h('p',null,item.situation||item.meaning||'尚无释义'),item.invalidReason?h('div',{className:'ab-note warn'},item.invalidReason):null,
        h('div',{className:'ab-flex'},h(Btn,{small:true,disabled:busy||item.status==='deleted',onClick:()=>setEditing(!editing)},editing?'收起编辑':'编辑'),h(Btn,{small:true,disabled:busy,onClick:load},'查看证据与版本'),...((item.status==='deleted')?[['restore','恢复到待审']]:[['approve','批准使用'],['disable','停用'],['delete','删除']]).map(([path,label])=>h(Btn,{key:path,small:true,disabled:busy,onClick:()=>act(path,b)},label))),
        editing?h(LearningEditor,{kind:item.kind,scope,item,busy,onSave:async patch=>{const r=await act('update',{...b,patch});if(r?.ok)setEditing(false)}}):null,
        details?h('div',{style:{marginTop:12}},...details.evidence.map(e=>h('div',{key:e.id||e.messageId,className:'ab-li'},h('div',{className:'body'},e.text||e.messageId||e.id,h('div',{className:'ab-small ab-muted'},e.authorId+' · '+(e.id||e.messageId))),h(Btn,{small:true,disabled:busy,onClick:()=>act('evidence/delete',{...b,messageId:e.id||e.messageId})},'移除证据'))),...details.audit.map((a,i)=>h('div',{key:i,className:'ab-li'},h('div',{className:'body'},'v'+a.revision+' · '+a.action+' · '+new Date(a.at).toLocaleString()),a.revision<item.revision&&item.status!=='deleted'?h(Btn,{small:true,disabled:busy,onClick:()=>act('revert',{...b,targetRevision:a.revision})},'回退并复核'):null))):null)
    }
    function Tasks({st,toast}) {
      const [scope,setScope,isCurrent]=useViewingScope({account:st.config.botQQ,chat:'private:'+st.config.ownerQQ,persona:''}),[items,setItems]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false)
      const load=useCallback(async()=>{if(!isCurrent())return;const r=await get('/tasks/list?'+new URLSearchParams({chatId:scope.chat,limit:50}));if(!isCurrent())return;if(r.ok){setItems(r.list||r.tasks||r.items||[]);setError('')}else setError(r.message)},[scope])
      useEffect(()=>{load()},[load])
      return h('div',{className:'ab-grid'},h(ScopePicker,{st,scope,onChange:next=>{setScope(next);setItems([]);setError('');setBusy(false)},persona:false}),h(Card,{title:'任务与等待',right:h(Btn,{small:true,onClick:load},'刷新'),desc:'统一查看生图、翻唱和 Planner 等待。取消等待不会取消它所等待的后台任务；结果未知不会自动重发。'},error?h('div',{className:'ab-note err'},error):null,...items.map(t=>h('div',{key:t.id,className:'ab-card',style:{marginTop:10}},h('div',{className:'ab-flex'},h('b',null,t.kind),h('span',{className:'ab-pill'},t.stateLabel||t.state)),h('div',{className:'ab-muted ab-small'},t.id+' · 请求者 '+t.actorId),t.condition?h('p',null,'等待 '+t.condition+' · 截止 '+new Date(t.deadline).toLocaleString()):null,t.error?h('div',{className:'ab-note warn'},t.error):null,h(Btn,{small:true,disabled:busy||['delivered','failed','canceled','unknown','woken','expired'].includes(t.state),onClick:async()=>{if(!isCurrent())return;setBusy(true);try{const r=await post('/tasks/cancel',{chatId:scope.chat,id:t.id});if(!isCurrent())return;toast(r.message||r.code,r.ok?'ok':'err');await load()}finally{if(isCurrent())setBusy(false)}}},'取消'))),!items.length?h(Empty,{text:'当前聊天没有任务或等待'}):null))
    }

    const MEMORY_STATES = { active: '有效', conflicted: '有冲突', superseded: '已更正', retracted: '已撤回', quarantined: '待复核', deleted: '已删除' }
    const PROFILE_SECTIONS = { identity: '身份', relationships: '关系', stableFacts: '稳定事实', preferences: '偏好', recentInteractions: '近期互动', uncertain: '待确认' }
    const memoryQuery = (scope, extra = {}) => new URLSearchParams({ ...scope, ...extra }).toString()
    // 只用已保存的配置和已有会话填充选项；选择范围不会写入 allow。
    function scopeChatOptions(st = {}, knownChats = []) {
      const config = st.config || {}, owner = String(config.ownerQQ || ''), chats = new Map()
      const add = (chat, label) => { if (/^(private|group):[\w-]+$/.test(chat) && !chats.has(chat)) chats.set(chat, { value: chat, label }) }
      if (owner) add('private:' + owner, '主人私聊 · ' + owner)
      for (const id of config.allow?.groups || []) {
        const name = st.groupNames?.[id]
        add('group:' + id, '群聊 · ' + (typeof name === 'string' && name ? name + '（' + id + '）' : id) + ' · 白名单')
      }
      for (const id of config.allow?.private || []) add('private:' + id, '私聊 · ' + id + ' · 白名单')
      for (const chat of [...Object.keys(st.sessions || {}).filter(k => k.startsWith('private:')), ...knownChats]) {
        add(chat, (chat.startsWith('group:') ? '群聊 · ' : '私聊 · ') + chat.split(':')[1] + ' · 已有会话')
      }
      return [...chats.values()]
    }
    // 旧范围的请求和事件即使晚于切换完成，也不能回填或操作新范围。
    function useViewingScope(initial) {
      const [scope, setScope] = useState(initial), current = useRef(scope), mounted = useRef(true)
      useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      return [scope, next => { current.current = next; setScope(next) }, () => mounted.current && current.current === scope]
    }
    function ScopePicker({ scope, onChange, st, knownChats, persona = true, personaHint, requirePersona = false }) {
      const options = scopeChatOptions(st, knownChats)
      const [value, setValue] = useState(scope), [custom, setCustom] = useState(() => !options.some(o => o.value === scope.chat))
      const [error, setError] = useState(''), [resolving, setResolving] = useState(false)
      const draft = useRef(scope), seq = useRef(0), applied = useRef(scope)
      applied.current = scope
      useEffect(() => {
        seq.current++; draft.current = { ...scope }; setValue(draft.current)
        setCustom(!scopeChatOptions(st, knownChats).some(o => o.value === scope.chat)); setError(''); setResolving(false)
        return () => { seq.current++ }
      }, [scope.account, scope.chat, scope.persona])
      const valid = s => !!s.account && /^(private|group):[\w-]+$/.test(s.chat)
      const update = (k, v) => {
        seq.current++; setError(''); setResolving(false)
        const next = { ...draft.current, [k]: v }
        if (k === 'chat' && v !== draft.current.chat) next.persona = ''
        draft.current = next; setValue(next)
      }
      const resolve = async (applyAfter = false) => {
        if (!valid(draft.current)) return
        const id = ++seq.current, source = applied.current, chat = draft.current.chat
        setError(''); setResolving(true)
        try {
          const r = await get('/persona/resolve?chatId=' + encodeURIComponent(chat))
          if (id !== seq.current || source !== applied.current) return
          if (!r.ok || r.error || !r.personaId) { setError(r.message || r.error || '当前聊天没有可用人设'); return }
          draft.current = { ...draft.current, persona: r.personaId }; setValue(draft.current)
          if (applyAfter === true) onChange({ ...draft.current })
        } catch (e) { if (id === seq.current && source === applied.current) setError(e.message) }
        finally { if (id === seq.current && source === applied.current) setResolving(false) }
      }
      const apply = () => {
        if (!valid(draft.current) || resolving) return
        if (persona && requirePersona && !draft.current.persona) return resolve(true)
        seq.current++; onChange({ ...draft.current })
      }
      const manual = custom || !options.some(o => o.value === value.chat)
      const personaControl = persona ? h(Row, { label: '人设 ID', hint: personaHint || (requirePersona ? '留空即可；切换查看时自动读取所选聊天当前人设。仅高级指定时填写。' : '普通事实留空；查看角色经历时填写对应人设 ID。切换聊天会清空旧人设。') }, h('input', { className: 'ab-input', 'aria-label': '人设范围', value: value.persona, onChange: e => update('persona', e.target.value.trim()) }), h(Btn, { small: true, disabled: !valid(value) || resolving, onClick: () => resolve() }, resolving ? '正在读取人设…' : '使用此聊天当前人设')) : null
      return h(Card, { title: '查看范围（一次一个聊天）', desc: '仅选择本页查看、编辑和审核的资料范围，不控制启用名单。真正启用聊天请到「权限」设置 allow 白名单；记忆和表达与黑话的开关是全局设置，不随查看范围切换。' },
        h('div', { className: 'ab-note' }, '当前查看：' + scope.chat + (persona && scope.persona ? ' · 人设 ' + scope.persona : '')),
        h(Row, { label: '机器人账号' }, h('input', { className: 'ab-input', 'aria-label': '机器人账号', value: value.account, readOnly: true })),
        h(Row, { label: '选择聊天', hint: '来自已保存白名单和已知私聊；选好后点「切换查看」。已有会话不代表已启用。' },
          h('select', { className: 'ab-input wide', 'aria-label': '选择查看的聊天', value: manual ? '' : value.chat, onChange: e => { setCustom(!e.target.value); update('chat', e.target.value) } },
            ...options.map(o => h('option', { key: o.value, value: o.value }, o.label)), h('option', { value: '' }, '列表外自定义…'))),
        manual ? h(Row, { label: '自定义聊天范围', hint: '一次填写一个 private:QQ号 或 group:群号；填写不会新增授权。' }, h('input', { className: 'ab-input wide', 'aria-label': '聊天范围', value: value.chat, onChange: e => update('chat', e.target.value.trim()) })) : null,
        persona && requirePersona ? h('details', null, h('summary', null, '高级：指定人设（默认自动读取）'), personaControl) : personaControl,
        error ? h('div', { className: 'ab-note err', role: 'alert' }, error) : null,
        h(Btn, { small: true, disabled: !valid(value) || resolving, onClick: apply }, resolving ? '正在切换…' : '切换查看'))
    }
    function ScopedMemory({ st, draft, setDraft, toast }) {
      const [scope, setScope] = useState({ account: st.config.botQQ, chat: 'private:' + st.config.ownerQQ, persona: '' })
      const f = useField(draft, setDraft)
      return h('div', { className: 'ab-grid' },
        h(ScopePicker, { st, scope, onChange: setScope }),
        h(Card, { title: '记忆设置（全局）', right: f.sw('memory.enabled'), desc: '本卡开关和参数全局生效，不随查看范围切换。增量提炼保留原始聊天和处理进度，失败区间留待重试。修改后使用页面底部保存。' },
          h(Row, { label: '每轮召回数量' }, f.range('memory.recallCount', 0, 12, 1, v => v + ' 条')),
          h(Row, { label: '积累消息数' }, f.range('memory.extraction.minMessages', 5, 100, 5, v => v + ' 条')),
          h(Row, { label: '最长等待提炼时间' }, f.range('memory.extraction.intervalMs', 300000, 7200000, 300000, v => Math.round(v / 60000) + ' 分钟'))),
        h(SharingPolicy,{draft,setDraft}),
        h(MemoryWorkspace, { key: JSON.stringify(scope), scope, actorId: st.config.ownerQQ, toast }))
    }
    const MEDIA_STATES={unanalysed:'未分析',waiting_asset:'等待原图',queued:'排队中',running:'分析中',ready:'可用',needs_frames:'动画需人工复核',failed:'失败',unknown:'结果不确定',disabled:'已停用',unavailable:'来源不可用'}
    function MediaMemory({st,draft,setDraft,toast}) {
      const f=useField(draft,setDraft),[scope,setScope]=useState({account:st.config.botQQ,chat:'private:'+st.config.ownerQQ,persona:''})
      return h('div',{className:'ab-grid'},h(ScopePicker,{st,scope,onChange:setScope,persona:false}),
        h(Card,{title:'图片描述与文字识别（全局设置）',right:f.sw('mediaMemory.enabled'),desc:'本卡配置不随查看范围切换。图片描述和 OCR 绑定到原始消息；也可填写人工说明，不调用模型。动画不会仅凭首帧被当作完整分析。'},
          h(Row,{label:'自动分析'},f.sw('mediaMemory.autoAnalyze')),h(Row,{label:'动画自动取帧',hint:'本地 ffmpeg 抽样，最多 6 帧；明确标记部分覆盖，无法取帧时保留待复核。'},f.sw('mediaMemory.autoFrames')),
          h(Row,{label:'自动分析执行名单（autoChats）',hint:'可填多个：一行一个 private:QQ 或 group:群号；留空不自动调用。这是执行名单，与上方查看范围无关，仍须通过「权限」allow。'},f.list('mediaMemory.autoChats')),
          h(Row,{label:'忽略这些发言者',hint:'一行一个 QQ 号'},f.list('mediaMemory.blockedAuthors')),
          h(Row,{label:'模型版本标记',hint:'视觉模型更换后修改；模型选择在「模型」页'},f.text('mediaMemory.modelVersion')),
          h(Row,{label:'每日调用上限'},f.num('mediaMemory.maxCallsPerDay',{min:0,max:1000})),
          h(Row,{label:'每聊天每日上限'},f.num('mediaMemory.maxCallsPerChatPerDay',{min:0,max:1000})),
          h(Row,{label:'调用间隔（毫秒）'},f.num('mediaMemory.minIntervalMs',{min:0,max:86400000})),
          h(Row,{label:'超时（毫秒）'},f.num('mediaMemory.timeoutMs',{min:10,max:60000})),
          h(Row,{label:'重试等待（毫秒）'},f.num('mediaMemory.retryBackoffMs',{min:0,max:86400000})),
          h(Row,{label:'队列上限'},f.num('mediaMemory.maxQueue',{min:1,max:500})),
          h(Row,{label:'来源有效期（天）'},f.num('mediaMemory.maxAgeDays',{min:1,max:365}))),
        h(MediaWorkspace,{key:scope.account+'|'+scope.chat,scope,enabled:st.config.mediaMemory.enabled,toast}))
    }
    function MediaWorkspace({scope,enabled,toast}) {
      const [items,setItems]=useState([]),[jobs,setJobs]=useState([]),[status,setStatus]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
      const load=useCallback(async()=>{const q='?'+new URLSearchParams({account:scope.account,chatId:scope.chat,limit:100});const r=await Promise.all([get('/media-memory/items'+q),get('/media-memory/jobs'+q),get('/media-memory/status'+q)]);if(r.some(x=>!x.ok)){setError(r.find(x=>!x.ok)?.message||'加载失败');return}setError('');setItems(r[0].items);setJobs(r[1].jobs);setStatus(r[2])},[scope.account,scope.chat])
      useEffect(()=>{let alive=true;load().catch(e=>{if(alive)setError(e.message)});return()=>{alive=false}},[load])
      const act=async(path,item,extra={})=>{setBusy(true);try{const r=await post('/media-memory/'+path,{account:scope.account,chatId:scope.chat,occurrenceId:item.occurrenceId,expectedRevision:item.revision,...extra});toast(r.ok?'已保存或登记任务':r.message,r.ok?'ok':'err');await load()}finally{setBusy(false)}}
      return h(Fragment,null,h(Card,{title:'图片来源工作台',right:h(Btn,{small:true,onClick:load},'刷新图片')},
        error?h('div',{className:'ab-note err',role:'alert'},error):null,
        status?h('p',{className:'ab-muted'},'今日调用 '+status.budget.used+' / '+status.budget.limit+' · 本聊天 '+status.budget.chatUsed+' / '+status.budget.chatLimit+' · 排队 '+status.queued):null,
        items.length?items.map(it=>h(MediaRecord,{key:it.occurrenceId+':'+it.revision,it,busy,enabled,act})):h(Empty,{text:'当前聊天没有可用的图片消息'})),
        h(Card,{title:'分析任务',desc:'结果未知表示调用可能已经执行，不会自动重复调用。只在核对后手动重试。'},jobs.length?jobs.map(j=>h('div',{className:'ab-li',key:j.id},h('div',{className:'body'},j.status+' · '+j.id,h('div',{className:'ab-small ab-muted'},j.occurrenceId+' · '+j.attempts+' 次尝试'),j.errorKind||''))):h(Empty,{text:'暂无分析任务'})))
    }
    function MediaRecord({it,busy,enabled,act}) {
      const [description,setDescription]=useState(it.result?.description||''),[ocr,setOcr]=useState(it.result?.ocr||'')
      const locked=busy||['disabled','unavailable','waiting_asset'].includes(it.status)
      return h('details',{className:'ab-card'},h('summary',{className:'ab-flex'},it.assetId?h('img',{src:assetUrl(it.assetId),alt:'聊天来源图片',style:{width:72,height:72,objectFit:'contain',borderRadius:8}}):null,h('div',{className:'body'},it.result?.description||it.occurrenceId,h('div',{className:'ab-small ab-muted'},(MEDIA_STATES[it.status]||it.status)+' · v'+it.revision+' · '+(it.coverage==='human'?'人工说明':it.coverage==='sampled_partial'?'动画抽样 · 部分内容':'模型/未分析')))),
        h('p',{className:'ab-small ab-muted'},'来源 '+it.messageId+' · '+it.chatId),it.error?h('div',{className:'ab-note warn'},it.error):null,
        h(Row,{label:'画面描述'},h('textarea',{className:'ab-textarea','aria-label':'图片人工描述',value:description,onChange:e=>setDescription(e.target.value)})),
        h(Row,{label:'图中文字'},h('textarea',{className:'ab-textarea','aria-label':'图片OCR文字',value:ocr,onChange:e=>setOcr(e.target.value)})),
        h('div',{className:'ab-flex'},h(Btn,{small:true,disabled:locked||!description.trim(),onClick:()=>act('analyze',it,{analysis:{version:1,description,ocr}})},'保存人工说明'),
          h(Btn,{small:true,disabled:locked||!enabled||['queued','running','failed','unknown'].includes(it.status),onClick:()=>act('analyze',it)},'调用视觉模型分析'),
          ['failed','unknown'].includes(it.status)?h(Btn,{small:true,disabled:busy||!enabled,onClick:()=>act('retry',it)},it.status==='unknown'?'核对后重试（可能再次计费）':'重试失败任务'):null,
          h(Btn,{small:true,kind:'ghost',disabled:busy||it.status==='unavailable',onClick:()=>act(it.status==='disabled'?'restore':'disable',it)},it.status==='disabled'?'恢复来源':'停用描述')))
    }
    const RETRIEVAL_ROLES={text:'文本向量',image:'图片向量',joint:'文本与图片联合空间'}
    const retrievalChannels=value=>(Array.isArray(value)?value:Object.keys(value||{})).join(' / ')
    function RetrievalPanel({st,draft,setDraft,toast,go}) {
      const f=useField(draft,setDraft),c=draft.retrieval,[scope,setScope,isCurrent]=useViewingScope({account:st.config.botQQ,chat:'private:'+st.config.ownerQQ,persona:''})
      const [health,setHealth]=useState(null),[query,setQuery]=useState(''),[kind,setKind]=useState('query'),[occurrence,setOccurrence]=useState(''),[result,setResult]=useState(null),[busy,setBusy]=useState(false),[generation,setGeneration]=useState(''),[role,setRole]=useState('text')
      const dirty=JSON.stringify(c)!==JSON.stringify(st.config.retrieval),seq=useRef(0)
      const load=useCallback(async()=>{const r=await get('/retrieval/health');setHealth(r)},[])
      useEffect(()=>{load()},[load,st.config.retrieval.enabled])
      useEffect(()=>{seq.current++;setResult(null)},[scope.account,scope.chat,scope.persona,kind])
      const act=async(path,body={})=>{if(!isCurrent())return;setBusy(true);try{const r=await post('/retrieval/'+path,{...scope,...body});if(!isCurrent())return;toast(r.ok?'操作已登记':(r.message||'操作失败')+(r.code?'（'+r.code+'）':''),r.ok?'ok':'err');await load();if(isCurrent())return r}finally{if(isCurrent())setBusy(false)}}
      const run=async()=>{if(!isCurrent())return;const id=++seq.current;setBusy(true);try{const r=await post('/retrieval/'+kind,{...scope,query,limit:20,...(kind==='images'&&occurrence?{occurrenceId:occurrence}:{})});if(id===seq.current&&isCurrent())setResult(r)}finally{if(id===seq.current&&isCurrent())setBusy(false)}}
      const addRole=r=>setDraft(setPath(draft,'retrieval.roles.'+r,{type:r==='text'?'openai-text':'fixed-http',baseUrl:'',apiKey:'',space:{spaceId:'aurabot-'+r+'-v1',provider:'',endpointIdentity:'',model:'',revision:'v1',dims:1024,metric:'cosine',modalities:r==='joint'?['text','image']:[r],prefixes:{query:'',document:''},normalization:'l2',preprocess:{text:{version:'1',unicode:'NFC',trim:true},...(r!=='text'?{image:{version:'1',mode:'passthrough'}}:{})},protocolMappingVersion:r==='text'?'openai-text-v1':'v1'},...(r==='text'?{samples:{text:['一只蓝色的猫','下雨天的城市']}}:{mapping:{},samples:{}})}))
      const active=st.config.retrieval.enabled&&!dirty
      return h('div',{className:'ab-grid'},
        h(Card,{title:'范围检索与派生索引',right:f.sw('retrieval.enabled'),desc:'词法检索可独立使用。配置向量服务后，手动探测通过才启用相应通道；探测、重建及向量查询会调用配置的提供方。修改后先保存。'},
          h(Row,{label:'索引后端'},f.select('retrieval.index.backend',[{value:'local',label:'本地 SQLite worker'},{value:'qdrant',label:'Qdrant 服务'}])),
          c.index.backend==='qdrant'?h(Fragment,null,h(Row,{label:'Qdrant 地址'},f.text('retrieval.index.baseUrl',{size:'wide',placeholder:'http://127.0.0.1:6333'})),h(Row,{label:'Qdrant 密钥'},f.text('retrieval.index.apiKey',{type:'password',placeholder:c.index.apiKeySet?'已保存，留空保留':''}))):null,
          h(Row,{label:'集合名称前缀'},f.text('retrieval.index.collectionPrefix')),
          h(Row,{label:'每次最多扫描候选'},f.num('retrieval.retrieval.maxCandidates',{min:1,max:10000})),
          h(Row,{label:'默认返回数量'},f.num('retrieval.retrieval.limit',{min:1,max:50})),
          h(Row,{label:'回复前检索等待上限',hint:'毫秒；超过后用词法结果继续回复。手动检索仍使用完整超时，重排只用于手动检索。'},f.num('retrieval.retrieval.contextTimeoutMs',{min:100,max:2000,step:100})),
          h(Row,{label:'索引批次大小'},f.num('retrieval.queue.batchSize',{min:1,max:128})),
          h(Row,{label:'增量检查间隔（毫秒）'},f.num('retrieval.sync.intervalMs',{min:1000,max:3600000})),
          ...Object.entries(RETRIEVAL_ROLES).map(([r,label])=>c.roles[r]?h(RetrievalRole,{key:r,role:r,label,value:c.roles[r],onChange:value=>setDraft(setPath(draft,'retrieval.roles.'+r,value)),onRemove:()=>{const roles={...c.roles};delete roles[r];setDraft(setPath(draft,'retrieval.roles',roles))}}):h(Btn,{key:r,small:true,onClick:()=>addRole(r)},'配置'+label))),
        h(Card,{title:'候选重排',right:f.sw('retrieval.reranker.enabled'),desc:'可选服务，只接收当前范围内的候选文本。超时或结果无效时保留已有检索排序；重排单独计入调用预算。'},
          h(Row,{label:'重排接口完整地址'},f.text('retrieval.reranker.endpoint',{size:'wide',placeholder:'https://your-provider/v1/rerank'})),
          h(Row,{label:'模型 ID'},f.text('retrieval.reranker.model',{size:'wide'})),
          h(Row,{label:'服务密钥'},f.text('retrieval.reranker.apiKey',{type:'password',placeholder:c.reranker?.apiKeySet?'已保存，留空保留':''})),
          h(Row,{label:'超时（毫秒）'},f.num('retrieval.reranker.timeoutMs',{min:1,max:30000})),
          h(Row,{label:'最多重排候选'},f.num('retrieval.reranker.maxCandidates',{min:1,max:128})),
          h(Row,{label:'每分钟调用上限'},f.num('retrieval.reranker.budget.maxCallsPerMinute',{min:0,max:600})),
          h(Row,{label:'每次输入字符上限'},f.num('retrieval.reranker.budget.maxInputChars',{min:1,max:524288})),
          h(Row,{label:'最大并发'},f.num('retrieval.reranker.budget.maxConcurrent',{min:1,max:8}))),
        h(Card,{title:'当前可用能力',right:h(Btn,{small:true,onClick:load},'刷新状态')},
          health?.ok===false?h('div',{className:'ab-note err'},health.message+' · '+health.code):null,
          !health?.enabled?h('p',{className:'ab-muted'},'当前未启用范围检索'):h(Fragment,null,
            h('div',{className:'ab-pills'},...Object.entries({lexical:'词法',textVector:'文本向量',imageVector:'图片向量',jointTextToImage:'跨模态图搜'}).map(([k,label])=>h('span',{key:k,className:'ab-pill'},label+' · '+(health.capabilities?.[k]?'可用':'未就绪')))),
            ...Object.entries(health.roles||{}).map(([r,value])=>h('p',{key:r},RETRIEVAL_ROLES[r]+'：'+(value.ready?'探测已通过':value.reason||value.error||'需探测'))),
            h('div',{className:'ab-muted ab-small'},'后端 '+(health.index?.backend||'正在初始化')+' · 待处理队列 '+(health.jobs?.length||0)),
            h(Btn,{small:true,disabled:busy||!active||!Object.keys(c.roles).length,onClick:()=>act('probe',{roles:Object.keys(c.roles)})},'探测已配置模型（调用服务）'))),
        h(ScopePicker,{st,scope,onChange:next=>{setScope(next);seq.current++;setResult(null);setBusy(false);setQuery('');setOccurrence('')}}),
        h(Card,{title:'检索工作台',desc:'只展示当前范围仍可见的来源。图片可直接带入生图工作台，提交时再次校验。'},
          h(Choices,{value:kind,onChange:setKind,options:[{value:'query',label:'事实记忆'},{value:'images',label:'历史图片'}]}),
          h(Row,{label:'查找内容'},h('input',{className:'ab-input wide','aria-label':'检索内容',value:query,onChange:e=>setQuery(e.target.value)})),
          kind==='images'?h(Row,{label:'以图找图',hint:'可选，填写一张当前可见图片的出现 ID'},h('input',{className:'ab-input wide','aria-label':'图片出现 ID',value:occurrence,onChange:e=>setOccurrence(e.target.value)})):null,
          h(Btn,{kind:'primary',small:true,disabled:busy||!active||(!query.trim()&&!occurrence),onClick:run},busy?'检索中…':'检索'),
          result?.ok===false?h('div',{className:'ab-note err',role:'alert'},result.message+' · '+result.code):null,
          result?.degraded?.length?h('div',{className:'ab-note'},'当前使用可用通道：'+result.degraded.map(x=>(RETRIEVAL_ROLES[x.channel]||x.channel)+' '+x.reason).join('；')):null,
          result?.truncated?h('div',{className:'ab-note warn'},'候选达到上限，请缩小范围；本次结果不覆盖完整历史。'):null,
          ...(result?.hits||[]).map(hit=>h('div',{key:hit.id,className:'ab-li'},kind==='images'?h('img',{className:'ab-thumb',src:assetUrl(hit.assetId),alt:'历史图片'}):null,h('div',{className:'body'},kind==='images'?hit.description||'没有图片描述':hit.it?.text||hit.text,h('div',{className:'ab-small ab-muted'},hit.id+' · '+retrievalChannels(hit.channels)),kind==='images'?h('div',{className:'ab-small ab-muted'},'来源作者 '+hit.sourceActor+' · '+hit.scope?.chat):null),kind==='images'?h(Btn,{small:true,disabled:busy,onClick:async()=>{const r=await act('reference/materialize',{occurrenceId:hit.occurrenceId,role:'identity'});if(!r?.ok)return;sessionStorage.setItem('aurabot.imageReference',JSON.stringify({account:scope.account,chatId:scope.chat,reference:{...r.reference,role:'identity'}}));go('imagegen')}},'作为生图参考'):null)),
          result?.ok&&!result.hits?.length?h(Empty,{text:'没有匹配的可见来源'}):null),
        h(Card,{title:'索引维护与任务',desc:'索引是可重建的派生数据。重建先写入新代次，完成后激活；原始事实和证据不受影响。'},
          h('div',{className:'ab-flex'},h(Select,{value:role,onChange:setRole,options:Object.entries(RETRIEVAL_ROLES).filter(([r])=>c.roles[r]).map(([value,label])=>({value,label}))}),h('input',{className:'ab-input','aria-label':'索引代次',value:generation,onChange:e=>setGeneration(e.target.value),placeholder:'新代次，如 v20261028'}),h(Btn,{small:true,disabled:busy||!active||!c.roles[role]||!generation.trim(),onClick:()=>act('rebuild',{role,generation,activate:true})},'重建本账号全部范围并激活'),h(Btn,{small:true,disabled:busy||!active,onClick:()=>act('sync')},'同步当前范围')),
          h('p',{className:'ab-muted ab-small'},'重建会覆盖本账号全部已登记范围，完成后统一切换；发现其他账号共用索引时会拒绝覆盖。'),
          ...(health?.jobs||[]).map(job=>h('div',{key:job.id,className:'ab-li'},h('div',{className:'body'},job.kind+' · '+job.state,h('div',{className:'ab-muted ab-small'},job.id),job.error?h('div',{className:'ab-note warn'},typeof job.error==='string'?job.error:job.error.code):null),h(Btn,{small:true,disabled:busy||!['queued','running','retry_wait'].includes(job.state),onClick:()=>act('cancel',{jobId:job.id})},'取消'),h(Btn,{small:true,disabled:busy||!['failed','cancelled','canceled'].includes(job.state),onClick:()=>act('retry',{jobId:job.id})},'重试')))))
    }
    function RetrievalRole({role,label,value,onChange,onRemove}) {
      const f=useField(value,onChange)
      return h('details',{open:true,className:'ab-card',style:{marginTop:12}},h('summary',null,label),
        h(Row,{label:'协议'},f.select('type',(role==='text'?['openai-text','fixed-http']:['fixed-http']).map(value=>({value,label:value==='openai-text'?'OpenAI 兼容文本 embedding':'固定 HTTP 映射'})))),
        h(Row,{label:'服务地址'},f.text('baseUrl',{size:'wide'})),h(Row,{label:'密钥'},f.text('apiKey',{type:'password',placeholder:value.apiKeySet?'已保存，留空保留':''})),
        ...[['space.spaceId','空间 ID'],['space.provider','提供方标识'],['space.endpointIdentity','端点标识'],['space.model','模型 ID'],['space.revision','模型版本']].map(([path,label])=>h(Row,{key:path,label},f.text(path,{size:'wide'}))),
        h(Row,{label:'向量维度'},f.num('space.dims',{min:1,max:65536})),h(Row,{label:'距离度量'},f.select('space.metric',['cosine','dot','euclidean'].map(value=>({value,label:value})))),
        h(Row,{label:'归一化'},f.select('space.normalization',[{value:'l2',label:'L2'},{value:'none',label:'服务返回原值'}])),
        h(Row,{label:'查询前缀'},f.text('space.prefixes.query',{size:'wide'})),h(Row,{label:'文档前缀'},f.text('space.prefixes.document',{size:'wide'})),
        h(Row,{label:'预处理定义'},h(JsonArea,{value:value.space.preprocess,onChange:v=>onChange(setPath(value,'space.preprocess',v))})),
        value.type==='fixed-http'?h(Row,{label:'HTTP 请求与响应映射'},h(JsonArea,{value:value.mapping,onChange:v=>onChange({...value,mapping:v})})):null,
        h(Row,{label:'探测样本',hint:'至少两条互不相同的样本；图片服务需真实图片样本'},h(JsonArea,{value:value.samples,onChange:v=>onChange({...value,samples:v})})),
        h(Row,{label:'探测数值容差',hint:'默认 0.00001；仅根据同模型单条与批量实测差异调整，最高 0.01'},h('input',{className:'ab-input sm',type:'number',min:0,max:0.01,step:0.00001,'aria-label':label+'探测数值容差',value:value.probeTolerance??0.00001,onChange:e=>onChange({...value,probeTolerance:Number(e.target.value)})})),
        role==='joint'?h(Row,{label:'跨模态对齐样本',hint:'text、positiveImage、negativeImage 是上方样本的序号'},h(JsonArea,{array:true,value:value.alignmentPairs||[],onChange:v=>onChange({...value,alignmentPairs:v})})):null,
        h(Btn,{small:true,onClick:onRemove},'移除此检索角色'))
    }
    function SharingPolicy({draft,setDraft}) {
      const groups=draft.memory.shareGroups||[],cats={fact:'事实',profile:'人物画像',image:'历史图片',expression:'表达习惯',jargon:'黑话',experience:'角色经历'}
      const put=list=>setDraft(setPath(draft,'memory.shareGroups',list)),update=(i,k,v)=>put(groups.map((g,n)=>n===i?{...g,[k]:v}:g))
      return h(Card,{title:'跨聊天资料共享（全局规则）',desc:'这是资料读取规则，与查看范围和聊天启用名单不同，不新增聊天授权，也不授予跨聊天编辑权限。同一账号、同一共享组内选中的类别可互相读取；角色经历与表达仍要求相同人设。撤销后后续读取和发送会重新核验。修改后点页面底部保存。'},
        ...groups.map((g,i)=>h('div',{key:i,className:'ab-card',style:{marginBottom:12}},
          h(Row,{label:'共享组 ID'},h('input',{className:'ab-input','aria-label':'共享组 ID',value:g.id,onChange:e=>update(i,'id',e.target.value)})),
          h(Row,{label:'互相读取资料的聊天',hint:'至少两个；一行一个 private:QQ号 或 group:群号。仅共享勾选的类别，不是启用白名单。'},h('textarea',{className:'ab-textarea','aria-label':'共享的聊天',value:g.chats.join('\n'),onChange:e=>update(i,'chats',e.target.value.split('\n'))})),
          h('div',{className:'ab-flex'},...Object.entries(cats).map(([category,label])=>h('label',{key:category},h('input',{type:'checkbox',checked:g.categories.includes(category),onChange:e=>update(i,'categories',e.target.checked?[...g.categories,category]:g.categories.filter(c=>c!==category))}),label))),
          h(Btn,{small:true,onClick:()=>put(groups.filter((_,n)=>n!==i))},'移除共享组'))),
        !groups.length?h('p',{className:'ab-muted'},'没有跨聊天共享组'):null,
        h(Btn,{small:true,onClick:()=>put([...groups,{id:'shared-'+(groups.length+1),chats:[],categories:['fact']}])},'新增共享组'))
    }
    function FactEditor({ initial, actorId, onSave, onCancel, label = '保存记忆' }) {
      const [fact, setFact] = useState(() => ({ text: '', subject: actorId, predicate: '', value: '', speakerId: actorId, polarity: 'positive', modality: 'asserted', stability: 'stable', conditions: [], eventTime: null, validFrom: null, validTo: null, slot: 'multi', profileSection: 'stableFacts', ...initial }))
      const [reason, setReason] = useState(''), [evidence, setEvidence] = useState(''), [busy, setBusy] = useState(false)
      const update = (k, v) => setFact({ ...fact, [k]: v })
      const field = (k, title, hint) => h(Row, { label: title, hint }, h('input', { className: 'ab-input wide', 'aria-label': title, value: fact[k] ?? '', onChange: e => update(k, e.target.value) }))
      const select = (k, title, options) => h(Row, { label: title }, h(Select, { value: fact[k], onChange: v => update(k, v), options: options.map(([value, label]) => ({ value, label })) }))
      const dateField = (k, title) => h(Row, { label: title }, h('input', { className: 'ab-input', 'aria-label': title, type: 'datetime-local', value: fact[k] == null ? '' : new Date(fact[k] - new Date(fact[k]).getTimezoneOffset() * 60000).toISOString().slice(0, 16), onChange: e => update(k, e.target.value ? new Date(e.target.value).getTime() : null) }))
      const save = async () => {
        setBusy(true)
        try {
          const keys = ['text','subject','predicate','value','speakerId','polarity','modality','stability','conditions','eventTime','validFrom','validTo','slot','profileSection']
          await onSave(Object.fromEntries(keys.map(k => [k, fact[k]])), { reason, manualEvidence: { kind: 'manual', text: evidence, speakerId: fact.speakerId, actorId, confirmed: true, eventTime: Date.now() } })
        } finally { setBusy(false) }
      }
      return h('div', { className: 'ab-card', style: { marginTop: 12 } },
        h('div', { className: 'ab-note' }, '这是一条管理员人工记录。保留说话人、否定、条件和时间；填写复核依据后保存。'),
        field('text', '事实表述'), field('subject', '关于谁', 'QQ 号或明确的主体 ID'), field('speakerId', '原始说话人'), field('predicate', '属性或关系', '例如：饮食偏好、见面时间'), field('value', '具体内容'),
        select('polarity', '肯定或否定', [['positive','肯定'],['negative','否定']]),
        select('modality', '话语性质', [['asserted','当事人确认'],['reported','转述'],['hypothetical','假设'],['plan','计划'],['joke','玩笑'],['uncertain','未确定']]),
        select('stability', '稳定性', [['stable','长期稳定'],['temporal','有时效'],['uncertain','待确认']]),
        select('slot', '是否只能有一个值', [['multi','允许多个值'],['single','单值，矛盾时标记冲突']]),
        select('profileSection', '画像分类', Object.entries(PROFILE_SECTIONS)),
        h(Row, { label: '成立条件', hint: '一行一条；留空表示无额外条件' }, h('textarea', { className: 'ab-textarea', 'aria-label': '成立条件', value: (fact.conditions || []).join('\n'), onChange: e => update('conditions', e.target.value.split('\n').filter(Boolean)) })),
        h(Row, { label: '条件是否尚不明确' }, h(Switch, { on: fact.conditions === null, onChange: v => update('conditions', v ? null : []) })),
        dateField('eventTime', '事件发生时间'), dateField('validFrom', '有效期起点'), dateField('validTo', '有效期终点'),
        h(Row, { label: '复核依据' }, h('textarea', { className: 'ab-textarea', 'aria-label': '复核依据', value: evidence, onChange: e => setEvidence(e.target.value), placeholder: '记录你核实过的原话或材料，并说明来源' })),
        h(Row, { label: '操作原因' }, h('input', { className: 'ab-input wide', 'aria-label': '操作原因', value: reason, onChange: e => setReason(e.target.value) })),
        h('div', { className: 'ab-flex' }, h(Btn, { small: true, kind: 'primary', disabled: busy || !reason.trim() || !evidence.trim() || !fact.text.trim() || !fact.predicate.trim() || !String(fact.value).trim(), onClick: save }, busy ? '保存中…' : label), h(Btn, { small: true, onClick: onCancel }, '取消编辑')))
    }
    function MemoryWorkspace({ scope, actorId, toast }) {
      const [data, setData] = useState(null), [q, setQ] = useState(''), [page, setPage] = useState('facts'), [adding, setAdding] = useState(false)
      const [error, setError] = useState(''), [busy, setBusy] = useState(false), [legacy, setLegacy] = useState(''), [review, setReview] = useState(null), [unassigned, setUnassigned] = useState(false)
      const loadSeq=useRef(0)
      const load = useCallback(async () => {
        const seq=++loadSeq.current
        const query = memoryQuery(scope, { includeInactive: 'true', includeUncertain: 'true', includeUnassigned: String(unassigned), q })
        const responses = await Promise.all(['/memories','/memory/extraction','/profiles','/memory/quarantine','/memory/recalls'].map(path => get(path + '?' + query)))
        if(seq!==loadSeq.current)return
        const bad = responses.find(r => !r.ok)
        if (bad) { setError(bad.message || '读取失败'); return }
        setError(''); setData({ facts: responses[0], extraction: responses[1], profiles: responses[2].list, quarantine: responses[3], recalls: responses[4].list })
      }, [JSON.stringify(scope), q, unassigned])
      useEffect(() => { const t = setTimeout(load, 250); return () => {clearTimeout(t);loadSeq.current++} }, [load])
      const act = async (path, body, success = '已保存') => {
        const r = await post(path, { ...body, scope, actorId })
        toast(r.ok ? success : r.message, r.ok ? 'ok' : 'err')
        if (r.ok) await load()
        return r
      }
      const cp = data?.extraction?.checkpoint
      return h('div', { className: 'ab-grid' },
        error ? h('div', { className: 'ab-note err', role: 'alert' }, error, h(Btn, { small: true, onClick: load }, '重试')) : null,
        h(Card, { title: '记忆工作台', desc: '当前范围：' + scope.chat + (scope.persona ? ' · 人设 ' + scope.persona : ' · 公共事实'), right: h(Btn, { small: true, onClick: load }, '刷新') },
          h(Choices, { value: page, onChange: setPage, options: [['facts','事实'],['profiles','人物画像'],['quarantine','待复核'],['recalls','召回记录']].map(([value, label]) => ({ value, label })) }),
          data ? h('div', { className: 'ab-pills' }, [['有效',data.facts.stats?.count],['冲突',data.facts.stats?.conflicted],['已失效',data.facts.stats?.outdated],['待复核',data.quarantine.items?.filter(x=>x.status==='quarantined').length]].map(([t,n]) => h('span', { className: 'ab-pill', key: t }, t + ' ' + (n || 0)))) : h(Empty, { text: '读取中…' }),
          page === 'facts' ? h(Fragment, null,
            h(Row, { label: '查找事实' }, h('input', { className: 'ab-input wide', 'aria-label': '查找事实', value: q, onChange: e => setQ(e.target.value) })),
            h(Btn, { small: true, onClick: () => setAdding(!adding) }, adding ? '收起新增' : '新增人工记忆'),
            adding ? h(FactEditor, { actorId, onCancel: () => setAdding(false), onSave: async (fact, meta) => { const r = await act('/memory/add', { ...fact, ...meta, source: 'panel' }); if (r.ok) setAdding(false) } }) : null,
            ...(data?.facts.items || []).map(fact => h(FactRecord, { key: fact.id + ':' + fact.revision, fact, scope, actorId, toast, act })),
            data && !data.facts.items.length ? h(Empty, { text: '当前范围没有匹配的事实' }) : null) : null,
          page === 'profiles' ? h(MemoryProfiles, { scope, actorId, list: data?.profiles || [], facts: data?.facts.items || [], act }) : null,
          page === 'quarantine' ? h(Fragment, null,
            h('div', { className: 'ab-note', style: { marginTop: 12 } }, '旧档案和已恢复的记录需要复核来源与范围。删除后的证据必须单独复核，才能重新启用事实。'),
            h(Row, { label: '包含范围未知的旧档案', hint: '只用于管理员复核；不会进入聊天上下文' }, h(Switch, { on: unassigned, onChange: setUnassigned })),
            ...(data?.facts.review || []).map(fact => h(FactRecord, { key: fact.id + ':' + fact.revision, fact, scope, actorId, toast, act })),
            [...(data?.quarantine.items || []), ...(data?.quarantine.unassigned || [])].filter(x=>x.status==='quarantined').map(item => h('div', { className: 'ab-card', key: item.id, style: { marginTop: 8 } },
              h('div', { className: 'ab-small ab-muted' }, item.scope ? item.scope.chat : '来源范围待核实'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 180, overflow: 'auto' } }, typeof item.payload === 'string' ? item.payload : JSON.stringify(item.payload, null, 2)),
              h(Btn, { small: true, onClick: () => setReview(item.id) }, '填写复核结果'),
              review === item.id ? h(FactEditor, { actorId, label: '确认范围并纳入记忆', onCancel: () => setReview(null), onSave: async (fact, meta) => { const r = await act('/memory/quarantine/approve', { id: item.id, fact: { ...fact, manualEvidence: meta.manualEvidence }, reason: meta.reason, approved: true }); if (r.ok) setReview(null) } }) : null)),
            h(Row, { label: '导入待复核材料', hint: '粘贴旧笔记或 JSON；不会自动认定为事实' }, h('textarea', { className: 'ab-textarea', 'aria-label': '导入待复核材料', value: legacy, onChange: e => setLegacy(e.target.value), maxLength: 30000 })),
            h(Btn, { small: true, disabled: !legacy.trim(), onClick: async () => { let payload; try { payload = JSON.parse(legacy) } catch { payload = { text: legacy } }; if (!payload || typeof payload !== 'object') payload = { text: legacy }; const r = await act('/memory/quarantine/import', { payload }, '已放入待复核区'); if (r.ok) setLegacy('') } }, '放入待复核区')) : null,
          page === 'recalls' ? (data?.recalls || []).map((entry,i) => h('div', { className: 'ab-card', key: i, style: { marginTop: 10 } }, h('b', null, entry.query || '空查询'), h('div', { className: 'ab-muted ab-small' }, timeAgo(entry.at)), entry.hits.length ? entry.hits.map(hit => h('div', { key: hit.id, className: 'ab-small' }, hit.id + ' · ' + Number(hit.score).toFixed(3) + ' · ' + (hit.why || []).join('、'))) : h('span', { className: 'ab-muted' }, '没有可见命中'))) : null),
        h(Card, { title: '增量提炼', desc: '处理完成后才推进检查点；原始记录保留供追溯。' },
          h('div', { className: 'ab-pills' }, h('span', { className: 'ab-pill' }, '已处理 ' + (cp?.recvSeq || 0)), h('span', { className: 'ab-pill' }, '接收至 ' + (cp?.watermark || 0)), h('span', { className: 'ab-pill' }, cp?.state || '等待')),
          h(BackgroundProgress, { state: cp, busy, onResume: () => act('/memory/extraction/resume', {}, '已恢复，下一批继续处理') }),
          cp?.error ? h('div', { className: 'ab-note err' }, cp.error) : null,
          h(Btn, { small: true, disabled: busy, onClick: async () => { setBusy(true); try { await act('/memory/extract', {}, '本次提炼已完成') } finally { setBusy(false) } } }, busy ? '正在提炼…' : '提炼当前范围'),
          ...(data?.extraction.pending || []).slice(0,8).map((item,i)=>h('div',{key:i,className:'ab-small ab-muted'}, (item.reason || item.error || item.state || '待处理') + ' · ' + (item.fromSeq || item.id || '')))))
    }
    function FactRecord({ fact, scope, actorId, toast, act }) {
      const [open, setOpen] = useState(false), [edit, setEdit] = useState(false), [detail, setDetail] = useState(null), [reason, setReason] = useState(''), [busy, setBusy] = useState(false)
      const own = !fact.scope || ['account','chat','persona'].every(k=>String(fact.scope[k]||'')===String(scope[k]||''))
      const load = async () => {
        const qs = memoryQuery(fact.scope || scope, { id: fact.id })
        const [e, a, raw] = await Promise.all([get('/memory/evidence/review?' + qs),get('/memory/audit?' + qs),get('/memory/evidence?' + qs)])
        if (!e.ok || !a.ok) { toast(e.message || a.message, 'err'); return }
        setDetail({ evidence: (e.items || []).map(item => ({ ...(raw.items || []).find(x => x.id === item.id), ...item })), audit: a.items || [] })
      }
      const action = async kind => {
        setBusy(true)
        try { await act('/memory/' + kind, { id: fact.id, reason, expectedRevision: fact.revision, approved: kind === 'approve' }) } finally { setBusy(false) }
      }
      return h('div', { className: 'ab-card', style: { marginTop: 10 } },
        h('div', { className: 'ab-flex' }, h('span', { className: 'ab-pill' }, MEMORY_STATES[fact.status] || fact.status), h('b', null, fact.text || '已删除记录'), h('span', { className: 'ab-small ab-muted' }, 'v' + fact.revision)),
        h('div', { className: 'ab-muted ab-small', style: { margin: '6px 0' } }, fact.id, fact.speakerId ? ' · 说话人 ' + fact.speakerId : '', fact.scope?.chat ? ' · ' + fact.scope.chat : ''),
        h('div', { className: 'ab-flex' }, h(Btn, { small: true, onClick: () => { setOpen(!open); if (!open) load() } }, open ? '收起证据' : '证据与修改记录'),
          own && ['active','conflicted'].includes(fact.status) ? h(Btn, { small: true, onClick: () => setEdit(!edit) }, '编辑事实') : null),
        edit ? h(FactEditor, { initial: fact, actorId, onCancel: () => setEdit(false), onSave: async (patch, meta) => { const r = await act('/memory/update', { id: fact.id, patch, expectedRevision: fact.revision, ...meta }); if (r.ok) setEdit(false) } }) : null,
        own ? h(Row, { label: '状态操作原因' }, h('input', { className: 'ab-input', 'aria-label': '状态操作原因 ' + fact.id, value: reason, onChange: e => setReason(e.target.value) }),
          ...(['active','conflicted'].includes(fact.status) ? [['retract','撤回'],['delete','删除']] : ['deleted','retracted','superseded'].includes(fact.status) ? [['restore','恢复到待复核']] : [['approve','确认复核并启用'],['delete','删除']]).map(([kind,label])=>h(Btn,{key:kind,small:true,disabled:busy || !reason.trim(),onClick:()=>action(kind)},label))) : null,
        open && detail ? h('div', { className: 'ab-grid', style: { marginTop: 10 } },
          detail.evidence.map(e => h('div', { className: 'ab-note', key: e.id }, h('b', null, e.speakerId || '来源'), ' · ' + new Date(e.eventTime || e.createdAt).toLocaleString(), h('div', null, e.text || e.evidence?.text || '证据已隐藏'), h('div', { className: 'ab-small ab-muted' }, e.id),
            own ? h('div', { className: 'ab-flex' }, ...[['refresh','刷新修改过的来源'],['delete','删除证据'],['approve','复核并恢复证据']].map(([kind,label])=>h(Btn,{key:kind,small:true,disabled:busy || !reason.trim(),onClick:async()=>{const r=await act('/memory/evidence/'+kind,{id:e.id,reason,expectedRevision:e.revision,approved:kind==='approve'});if(r.ok)load()}},label))) : null)),
          detail.audit.map(a=>h('details',{key:a.seq},h('summary',null,new Date(a.at).toLocaleString()+' · '+a.action+' · '+a.reason),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},JSON.stringify({before:a.before,after:a.after},null,2))))) : null)
    }
    function MemoryProfiles({ list, facts, act }) {
      const [subject, setSubject] = useState('')
      return h('div', { className: 'ab-grid', style: { marginTop: 12 } },
        h(Row, { label: '人物 QQ / 主体 ID' }, h('input', { className: 'ab-input', 'aria-label': '画像主体', value: subject, onChange: e=>setSubject(e.target.value) }), h(Btn,{small:true,disabled:!subject.trim(),onClick:()=>act('/profiles/rebuild',{subject:subject.trim()},'画像已更新')},'按当前证据重建')),
        ...list.map(profile=>h(MemoryProfile,{key:profile.subject+profile.fingerprint,profile,facts,act})))
    }
    function MemoryProfile({ profile, facts, act }) {
      const [aliases, setAliases] = useState((profile.override?.aliases || []).join('、')), [entries, setEntries] = useState(profile.override?.entries || []), [reason, setReason] = useState('')
      const setEntry = (i,k,v)=>setEntries(entries.map((e,j)=>j===i?{...e,[k]:v}:e))
      return h(Card, { title: profile.subject, desc: '每条画像都指向当前可见事实；临时、转述和争议内容保留在对应类别。' },
        ...Object.entries(profile.sections || {}).filter(([,values])=>values.length).map(([key,values])=>h('div',{key,style:{marginBottom:10}},h('b',null,PROFILE_SECTIONS[key]||key),...values.map((v,i)=>h('div',{key:i},v.text,h('div',{className:'ab-small ab-muted'},(v.factIds||[]).join(' · ')))))),
        h(Row,{label:'人工别名',hint:'用顿号或逗号分隔'},h('input',{className:'ab-input wide','aria-label':'人工别名',value:aliases,onChange:e=>setAliases(e.target.value)})),
        ...entries.map((entry,i)=>h('div',{className:'ab-card',key:i},h(Select,{value:entry.section,onChange:v=>setEntry(i,'section',v),options:Object.entries(PROFILE_SECTIONS).map(([value,label])=>({value,label}))}),
          h('input',{className:'ab-input wide','aria-label':'人工画像内容',value:entry.text,onChange:e=>setEntry(i,'text',e.target.value)}),
          h('div',{className:'ab-small ab-muted'},'勾选支撑这句话的事实：'),
          ...facts.filter(f=>f.subject===profile.subject && ['active','conflicted'].includes(f.status)).map(f=>h('label',{key:f.id,style:{display:'block'}},h('input',{type:'checkbox',checked:entry.factIds.includes(f.id),onChange:e=>setEntry(i,'factIds',e.target.checked?[...entry.factIds,f.id]:entry.factIds.filter(id=>id!==f.id))}),f.text)),
          h(Btn,{small:true,onClick:()=>setEntries(entries.filter((_,j)=>j!==i))},'移除此条覆盖'))),
        h(Btn,{small:true,onClick:()=>setEntries([...entries,{section:'stableFacts',text:'',factIds:[]}])},'添加人工覆盖'),
        h(Row,{label:'修改原因'},h('input',{className:'ab-input','aria-label':'画像修改原因',value:reason,onChange:e=>setReason(e.target.value)}),h(Btn,{small:true,disabled:!reason.trim(),onClick:async()=>{const r=await act('/profiles/save',{subject:profile.subject,override:{aliases:aliases.split(/[、,，]/).map(x=>x.trim()).filter(Boolean),entries},expectedRevision:profile.override?.revision||0,reason});if(r.ok)await act('/profiles/rebuild',{subject:profile.subject},'人工覆盖已应用')}},'保存画像覆盖')))
    }

    /** 导入音色：把 .zip / .pth / .index 拖进来或点选，自动识别；下面列出已有的音色，可以删。 */
    function VoiceImport({ s, toast, onChange }) {
      const [over, setOver] = useState(false)
      const [busy, setBusy] = useState('')
      const upload = async (files) => {
        for (const file of [...files]) {
          if (!/\.(zip|pth|index|ckpt)$/i.test(file.name)) { toast('「' + file.name + '」不是 .zip / .pth / .index / .ckpt', 'err'); continue }
          setBusy('正在导入「' + file.name + '」（' + Math.round(file.size / 1024 / 1024) + 'MB）…')
          const r = await fetch(API + '/song/import?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
            .then((x) => x.json()).catch((e) => ({ ok: false, message: '上传失败：' + e.message }))
          toast(r.message, r.ok ? 'ok' : 'err')
        }
        setBusy('')
        onChange()
      }
      const pick = () => {
        const inp = document.createElement('input')
        inp.type = 'file'
        inp.multiple = true
        inp.accept = '.zip,.pth,.index,.ckpt'
        inp.onchange = () => inp.files && upload(inp.files)
        inp.click()
      }
      return h(Card, { title: '音色模型', desc: '插件不自带音色。把你有权使用的 RVC 模型导进来：.pth（可以带 .index），或者装着它们的 zip。只存在本机。自己训练的是 so-vits-svc 之类别的模型、或者想用自己的推理参数？去「本地接口」页接「翻唱换声」。' },
        h('div', {
          className: 'ab-drop' + (over ? ' over' : ''), role: 'button', tabIndex: 0,
          onClick: pick, onKeyDown: (e) => (e.key === 'Enter' || e.key === ' ') && pick(),
          onDragOver: (e) => { e.preventDefault(); setOver(true) }, onDragLeave: () => setOver(false),
          onDrop: (e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files) },
        }, busy ? h('span', null, h('i', { className: 'ab-spin' }), ' ' + busy) : h('span', null, '把 .zip / .pth / .index 拖到这里，或者点击选择文件')),
        // 分离模型自动下载不动时：给几个地址，用浏览器或下载工具下好，拖进上面这个框
        s.parts && !s.parts.separatorModel && (s.separatorLinks || []).length ? h('div', { className: 'ab-note', style: { marginTop: 10 } },
          h('b', null, '人声分离模型下不动？'), ' 安装时会自动试好几个源（断了能接着下，太慢会换源）。实在不行，用浏览器或下载工具下好下面任一个（约 640 MB，是同一个文件），拖进上面这个框就行，插件会核对文件对不对：',
          (s.separatorLinks || []).map((u) => h('div', { key: u, className: 'ab-flex', style: { marginTop: 4 } },
            h('code', { className: 'ab-small', style: { wordBreak: 'break-all', flex: 1 } }, u),
            h(Btn, { small: true, kind: 'ghost', onClick: () => { navigator.clipboard.writeText(u); toast('复制了', 'ok') } }, '复制')))) : null,
        s.voices.length && !s.enabled ? h('div', { className: 'ab-note warn', style: { marginTop: 10 } }, '音色导入好了，但翻唱开关还没开（这一页最上面），打开并保存后她才会唱。') : null,
        s.voices.length === 0 ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '还没有音色。') :
          h('div', { className: 'ab-list', style: { marginTop: 10 } }, s.voices.map((v) => h('div', { key: v.id, className: 'ab-li' },
            h('div', { className: 'body' }, h('b', null, v.id), v.hasIndex ? h('span', { className: 'ab-muted ab-small' }, ' · 带 index') : null),
            h(Btn, { small: true, kind: 'ghost', onClick: async () => { if (!confirm('删掉音色「' + v.id + '」？')) return; const r = await post('/song/voice/delete', { id: v.id }); toast(r.message, r.ok ? 'ok' : 'err'); onChange() } }, '删除')))))
    }

    const fmtBytes = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : (n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB')
    const fmtDur = (ms) => { const sec = Math.max(0, Math.round(ms / 1000)); return sec >= 60 ? Math.floor(sec / 60) + ' 分 ' + (sec % 60) + ' 秒' : sec + ' 秒' }

    /** 装到哪里：列出每个盘和剩余空间，点一下选；也可以自己填路径。 */
    function RootPicker({ draft, setDraft, s }) {
      const val = draft.song.root || ''
      const cur = val || s.defaultRoot
      const [drives, setDrives] = useState([])
      const [chk, setChk] = useState(null)
      useEffect(() => { get('/song/drives').then((r) => setDrives(r.list || [])) }, [])
      useEffect(() => {
        const t = setTimeout(() => get('/song/root/check?path=' + encodeURIComponent(cur)).then(setChk), 300)
        return () => clearTimeout(t)
      }, [cur])
      const pick = (root) => setDraft(setPath(draft, 'song.root', root === s.defaultRoot ? '' : root))
      return h('div', { style: { width: '100%' } },
        h('div', { className: 'ab-drives' },
          h('button', { type: 'button', className: cx('ab-drive', !val && 'on'), onClick: () => pick(s.defaultRoot) }, h('b', null, '默认位置'), h('small', null, s.defaultRoot)),
          drives.map((d) => h('button', { key: d.drive, type: 'button', className: cx('ab-drive', val.toLowerCase() === d.root.toLowerCase() && 'on', d.freeGB < 10 && 'low'), onClick: () => pick(d.root) },
            h('b', null, d.drive + ' 盘'), h('small', null, '剩 ' + d.freeGB + ' GB / 共 ' + Math.round(d.totalGB) + ' GB'),
            h('span', { className: 'bar' }, h('i', { style: { width: Math.round((1 - d.freeGB / d.totalGB) * 100) + '%' } }))))),
        h('input', { className: 'ab-input wide', style: { marginTop: 8 }, value: val, placeholder: '或者自己填路径，留空 = 默认位置（' + s.defaultRoot + '）', onChange: (e) => setDraft(setPath(draft, 'song.root', e.target.value)) }),
        chk ? h('div', { className: 'ab-small', style: { marginTop: 4, color: !chk.ok || chk.warn ? 'var(--ab-warn)' : 'var(--ab-sub)' } },
          !chk.ok ? chk.message : ['装在 ' + cur, chk.freeGB !== null ? '这个盘还剩 ' + chk.freeGB + ' GB' : '', chk.warn].filter(Boolean).join('；')) : null,
        val && val !== s.root && s.voices.length ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 2 } }, '换位置后，已导入的音色要重新导入（或把原来的 models 文件夹搬过去）') : null)
    }

    /** 安装进度：步骤条 + 当前这一步的用时、预计、下载量和网速，一看就知道没卡住。 */
    function InstallProgress({ inst }) {
      const pr = inst.progress
      const now = Date.now()
      const steps = inst.steps || []
      return h('div', { className: 'ab-install' },
        h('div', { className: 'ab-install-steps' }, steps.map((name, i) => h('div', { key: i, className: cx('st', i < inst.stepIndex && 'done', i === inst.stepIndex && 'on'), title: name },
          h('i', null, i < inst.stepIndex ? '✓' : i + 1), h('span', null, name.replace(/（.*?）/g, ''))))),
        h('div', { className: 'ab-flex', style: { marginTop: 12 } }, h('i', { className: 'ab-spin' }), h('b', null, '第 ' + (inst.stepIndex + 1) + ' / ' + steps.length + ' 步：' + inst.step), h('div', { className: 'ab-spacer' }),
          h('span', { className: 'ab-muted ab-small' }, '这一步 ' + fmtDur(now - inst.stepAt) + ' · 总共 ' + fmtDur(now - inst.startedAt))),
        inst.stepHint ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 2 } }, '预计：' + inst.stepHint) : null,
        pr && pr.kind === 'download' ? h('div', { className: 'ab-install-dl' },
          h('div', null, h('small', null, '已下载'), h('b', null, fmtBytes(pr.done))),
          h('div', null, h('small', null, '当前网速'), h('b', { style: { color: pr.speed < 20 * 1024 ? 'var(--ab-warn)' : undefined } }, fmtBytes(pr.speed) + '/s')),
          pr.speed < 20 * 1024 ? h('div', { className: 'ab-small', style: { color: 'var(--ab-warn)', flex: '1 1 220px' } }, '很慢的话：打开「用国内镜像下载」后重新点安装（已下好的不会重下），或者开着代理') : null) : null,
        pr && pr.kind === 'file' && pr.total ? h('div', { style: { marginTop: 10 } },
          h('div', { className: 'ab-flex ab-small' }, h('span', null, pr.name), h('div', { className: 'ab-spacer' }), h('span', null, fmtBytes(pr.done) + ' / ' + fmtBytes(pr.total) + '（' + Math.round((pr.done / pr.total) * 100) + '%）')),
          h('div', { className: 'ab-mood', style: { marginTop: 4 } }, h('i', { style: { width: Math.round((pr.done / pr.total) * 100) + '%' } }))) : null)
    }

    const SONG_PARTS = [['python', 'Python 环境'], ['applio', 'Applio（RVC 推理引擎）'], ['separator', '人声分离'], ['ffmpeg', 'ffmpeg（混音）'], ['weights', '预训练文件（音高、音色特征）'], ['separatorModel', '人声分离模型']]

    function Song({ st, draft, setDraft, toast }) {
      const f = useField(draft, setDraft)
      const [s, setS] = useState(st.song)
      const [q, setQ] = useState('')
      const [found, setFound] = useState(null)
      const [pitch, setPitch] = useState(0)
      const [acct, setAcct] = useState(null)
      const load = () => get('/song/status').then((r) => r.ok && setS(r))
      // 安装中 / 正在唱的时候每 3 秒刷新一次进度
      useEffect(() => {
        load()
        const busy = s && (s.install.running || s.current || s.queue.length)
        if (!busy) return
        const t = setInterval(load, 3000)
        return () => clearInterval(t)
      }, [s && s.install.running, s && Boolean(s.current), s && s.queue.length])
      if (!s) return h(Empty, { icon: '⏳', text: '加载中…' })
      const search = async () => { if (!q.trim()) return; setFound(null); const r = await get('/song/search?q=' + encodeURIComponent(q)); setFound(r.list || []); if (!r.ok) toast(r.message, 'err') }
      const sing = async (song) => { const r = await post('/song/request', { songId: song.id, song: song.name + ' ' + song.artists, track: song.name, artist: song.artists, pitch }); toast(r.message, r.ok ? 'ok' : 'err'); load() }
      const voices = s.voices.map((v) => ({ value: v.id, label: v.id, desc: v.hasIndex ? '带 .index' : '' }))
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '翻唱', right: f.sw('song.enabled'), desc: '让她用自己的声音唱歌：点歌 → 从网易云下载 → 分离人声和伴奏 → 用 RVC 换成她的声音 → 混音 → 发语音条。主人在 QQ 里说「唱首歌」，或者发 /sing 歌名 都行。' },
          h('div', { className: cx('ab-note', s.ready ? '' : 'warn') }, s.message),
          h('div', { className: 'ab-checks', style: { marginTop: 12 } },
            SONG_PARTS.map(([k, label]) => h('div', { key: k, className: cx('ab-check', s.parts[k] && 'done') }, h('i', null, s.parts[k] ? '✓' : '·'), label)),
            h('div', { className: cx('ab-check', s.voices.length && 'done'), title: s.voices.map((v) => v.id).join('、') }, h('i', null, s.voices.length ? '✓' : '·'), s.voices.length ? '音色模型 ×' + s.voices.length : '音色模型（在下面导入）')),
          s.install.running ? null : h('div', { style: { marginTop: 12 } },
            h(Row, { label: '装到哪里', hint: '装完约 8 GB，音色模型也放这里。改了要先保存设置再点安装' }, h(RootPicker, { draft, setDraft, s })),
            h(Row, { label: '下载源', hint: '自动：安装前先测一下，官方源慢就用国内镜像（阿里云 / 南京大学 / npmmirror）' },
              h(Select, { value: draft.song.pypiMirror || 'auto', width: 220, onChange: (v) => setDraft(setPath(draft, 'song.pypiMirror', v)), options: [{ value: 'auto', label: '自动（推荐）' }, { value: 'cn', label: '一直用国内镜像' }, { value: 'off', label: '只用官方源' }] }))),
          h('div', { className: 'ab-flex', style: { marginTop: 12 } },
            h(Btn, { kind: 'primary', small: true, disabled: s.install.running || (draft.song.root || '') !== (st.config.song.root || ''), onClick: async () => { const r = await post('/song/install'); toast(r.message); setTimeout(load, 800) } },
              s.install.running ? h(Fragment, null, h('i', { className: 'ab-spin' }), ' 正在安装…') : Object.values(s.parts).every(Boolean) ? '重新检查 / 修复安装' : '一键安装'),
            h('span', { className: 'ab-muted ab-small' }, (draft.song.root || '') !== (st.config.song.root || '') ? '安装位置改了，先保存设置' : '需要 NVIDIA 显卡；装在 ' + s.root)),
          s.install.running ? h(InstallProgress, { inst: s.install }) : null,
          s.install.ok === true && !s.install.running ? h('div', { className: 'ab-note', style: { marginTop: 8 } }, '✓ ' + s.install.message) : null,
          s.install.log.length ? h('details', { style: { marginTop: 8 } }, h('summary', { className: 'ab-muted ab-small', style: { cursor: 'pointer' } }, '详细日志'),
            h('div', { className: 'ab-logs', style: { maxHeight: 180, marginTop: 6, padding: '8px 12px', whiteSpace: 'pre-wrap' } }, s.install.log.slice(-20).join('\n'))) : null,
          s.install.ok === false && !s.install.running ? h('div', { className: 'ab-note err', style: { marginTop: 8 } },
            h('div', null, s.install.message),
            h('div', { className: 'ab-flex', style: { marginTop: 8 } },
              h(Btn, { small: true, kind: 'primary', onClick: async () => { const r = await post('/song/install'); toast(r.message); setTimeout(load, 800) } }, '再试一次'),
              h(Btn, { small: true, onClick: () => { try { navigator.clipboard.writeText(['Aurabot ' + st.version + ' 翻唱安装失败', s.install.message, '', s.install.error || '', '', ...(s.install.log || []).slice(-30)].join('\n')); toast('报错复制好了，发给作者就行', 'ok') } catch (e) { toast('复制失败，展开「详细日志」手动复制吧', 'err') } } }, '复制报错'),
              h('span', { className: 'ab-muted ab-small' }, '已经下好的部分不会重下'))) : null,
        ),
        h(VoiceImport, { s, toast, onChange: load }),
        h(Card, { title: '声音', desc: '用哪个音色唱、默认变调和语音条的长度。' },
          h(Row, { label: '音色' }, voices.length ? h(Select, { value: draft.song.voice || (voices[0] && voices[0].value), options: voices, onChange: (v) => setDraft(setPath(draft, 'song.voice', v)) }) : h('span', { className: 'ab-muted' }, '还没有模型')),
          h(Row, { label: '默认变调', hint: '她自己点歌时会按原唱男声 / 女声定，这里是你在面板里试唱时的默认值' }, f.range('song.pitch', -12, 12, 1, (v) => (v > 0 ? '+' : '') + v + ' 半音')),
          h(Row, { label: '语音条最长', hint: '歌比这个长就截一段' }, f.range('song.maxVoiceSec', 30, 300, 10, (v) => v + ' 秒')),
          h(Row, { label: '截哪一段' }, f.choices('song.clipStart', [{ value: 'auto', label: '副歌附近', desc: '从全曲大约 30% 的地方开始' }, { value: 'head', label: '从头开始' }])),
          h(Row, { label: '人声音量' }, f.range('song.vocalVolume', 0.2, 2, 0.05, (v) => Math.round(v * 100) + '%')),
          h(Row, { label: '伴奏音量' }, f.range('song.instVolume', 0.1, 2, 0.05, (v) => Math.round(v * 100) + '%')),
          h(Row, { label: '只有主人能点歌' }, f.sw('song.ownerOnly')),
        ),
        h(Card, { title: '网易云', desc: '不登录也能唱免费歌；会员歌、版权歌要填网易云的 Cookie。' },
          h(Row, { label: 'Cookie（MUSIC_U）', hint: '电脑浏览器登录 music.163.com → F12 → 应用 / 存储 → Cookie → 复制 MUSIC_U 的值。只存在本机，不显示' },
            f.text('song.neteaseCookie', { type: 'password', size: 'wide', placeholder: draft.song.neteaseCookieSet ? '已保存（不改就留空）' : '没有就留空' })),
          h('div', { className: 'ab-flex', style: { marginTop: 6 } },
            h(Btn, { small: true, onClick: async () => { const r = await get('/song/account'); setAcct(r) } }, '检查登录'),
            acct ? h('span', { className: 'ab-small', style: { color: acct.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, acct.ok ? '已登录：' + acct.nickname + (acct.vip ? '（会员）' : '（不是会员，只能下免费歌）') : acct.message) : null),
        ),
        h(Card, { title: '试唱', desc: '搜一首歌让她唱，做好会发到你的 QQ 私聊。' },
          h('div', { className: 'ab-flex' },
            h('input', { className: 'ab-input', style: { flex: '1 1 260px' }, placeholder: '歌名，可以带歌手：小幸运 田馥甄', value: q, onChange: (e) => setQ(e.target.value), onKeyDown: (e) => e.key === 'Enter' && search() }),
            h(Btn, { small: true, onClick: search, disabled: !q.trim() }, '搜索'),
            h('span', { className: 'ab-muted ab-small' }, '变调'),
            h('input', { className: 'ab-input sm', type: 'number', min: -24, max: 24, value: pitch, onChange: (e) => setPitch(Number(e.target.value) || 0) })),
          found === null ? null : found.length === 0 ? h('div', { className: 'ab-muted', style: { marginTop: 8 } }, '没搜到') :
            h('table', { className: 'ab-table', style: { marginTop: 10 } }, h('tbody', null, found.map((x) => h('tr', { key: x.id },
              h('td', null, x.name, x.vip ? h('span', { className: 'ab-badge', style: { marginLeft: 6 } }, '会员') : null),
              h('td', { className: 'ab-muted' }, x.artists),
              h('td', { className: 'ab-muted' }, Math.floor(x.durationSec / 60) + ':' + String(x.durationSec % 60).padStart(2, '0')),
              h('td', null, h(Btn, { small: true, kind: 'primary', disabled: !s.ready || !draft.song.enabled, onClick: () => sing(x) }, '唱给我听')))))),
          !draft.song.enabled ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 8 } }, '先打开上面的「翻唱」开关并保存。') : null,
          s.current ? h('div', { className: 'ab-note', style: { marginTop: 10 } }, h('i', { className: 'ab-spin' }), ' 正在唱「' + s.current.title + '」：' + s.current.stage + (s.queue.length ? '（后面还有 ' + s.queue.length + ' 首）' : '')) : null,
          s.history.length ? h('div', { className: 'ab-list', style: { marginTop: 10 } }, s.history.map((x, i) => h('div', { key: i, className: 'ab-li' },
            h('div', { className: 'meta' }, timeAgo(x.at)),
            h('div', { className: 'body' }, (x.ok ? '✓ ' : '· ') + (x.title || '尚未匹配曲目'),
              h('div', { className: 'ab-muted ab-small' }, '请求：' + (x.requested?.query || x.query || '—') + ' · 阶段：' + (x.stage || x.state) + ' · 曲库匹配：' + (x.match?.status || 'pending') + ' · 送达：' + (x.delivered ? '已确认' : '未确认') + (x.receipt?.message_id ? ' · 回执 ' + x.receipt.message_id : '')),
              h('div', { className: 'ab-muted ab-small' }, x.message),
              h('div', { className: 'ab-flex' }, h('code', { className: 'ab-small' }, x.id),
                ['queued','preparing','running','retry_wait','submitting','polling','sending'].includes(x.state) ? h(Btn, { small: true, onClick: async()=>{const r=await post('/song/cancel',{id:x.id,chatId:x.chatId});toast(r.message||'已请求取消',r.ok?'ok':'err');load()} }, '取消任务') : null,
                x.assetId && x.delivery?.failed && !x.delivery?.unknown ? h(Btn, { small: true, onClick: async()=>{const r=await post('/song/resend',{id:x.id,chatId:x.chatId});toast(r.message||'已登记发送',r.ok?'ok':'err');load()} }, '重发已有音频') : null))))) : null,
        ),
      )
    }

/** B 站 Cookie：SESSDATA 和 bili_jct 分两个框填（前缀已经写好），可以显示 / 隐藏；粘整串也行，会自动拆开。 */
    function BiliCookie({ draft, setDraft }) {
      const [show, setShow] = useState(false)
      const b = draft.bili
      const field = (key, prefix, setKey, hintKey, ph) => h('div', { className: 'ab-flex', style: { flexWrap: 'nowrap', marginBottom: 6 } },
        h('code', { className: 'ab-small', style: { minWidth: 82, textAlign: 'right' } }, prefix),
        h('input', {
          className: 'ab-input wide', type: show ? 'text' : 'password', autoComplete: 'off', spellCheck: false, value: b[key] || '',
          placeholder: b[setKey] ? '已保存（结尾 ' + (b[hintKey] || '…') + '），不改就留空' : ph,
          onChange: (e) => setDraft(setPath(draft, 'bili.' + key, e.target.value.trim())),
        }))
      return h(Row, { label: 'B 站 Cookie', hint: '电脑浏览器登录 bilibili.com → F12 → 「应用」（Application）→ Cookie → bilibili.com，分别复制 SESSDATA 和 bili_jct 这两行的「值」。也可以直接粘整串 Cookie，会自动拆开。只存在本机；不填也能看视频，但看不到 AI 字幕、不能评论和回复。建议用小号' },
        h('div', { style: { flex: 1 } },
          field('sessdata', 'SESSDATA=', 'sessdataSet', 'sessdataHint', '粘贴 SESSDATA 的值'),
          field('biliJct', 'bili_jct=', 'biliJctSet', 'biliJctHint', '粘贴 bili_jct 的值'),
          h('div', { className: 'ab-flex' },
            h(Btn, { small: true, onClick: () => setShow(!show) }, show ? '隐藏' : '显示'),
            b.sessdataSet || b.biliJctSet ? h(Btn, { small: true, kind: 'ghost', onClick: () => { if (confirm('清空保存的 B 站 Cookie？')) setDraft(setPath(setPath(setPath(draft, 'bili.sessdata', null), 'bili.biliJct', null), 'bili.cookie', null)) } }, '清空') : null,
            h('span', { className: 'ab-muted ab-small' }, '「显示」看的是正在填的内容；保存过的出于安全不回传，只显示结尾几位'))))
    }

/** 本地接口：数据目录 local/ 里的脚本接管语音合成、生图、翻唱换声、语音识别。 */
    function LocalApi({ draft, setDraft, toast }) {
      const f = useField(draft, setDraft)
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState('')
      const [img, setImg] = useState('')
      const load = () => get('/local/status').then(setSt)
      useEffect(() => { load() }, [])
      const act = async (path, slot, label) => { setBusy(slot + label); const r = await post(path, { slot }); setBusy(''); toast(r.message, r.ok ? 'ok' : 'err'); if (r.image) setImg(r.image); load() }
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '本地接口', desc: '想用自己电脑上的模型或服务（GPT-SoVITS 语音、SD WebUI / ComfyUI 画图、自己训练的 so-vits-svc 音色、本地语音识别……）？在这里生成一个脚本模板，照注释改，或者点「复制给 DSH 的话」粘给 DSH，让它帮你改。脚本放在插件数据目录的 local 文件夹里，插件升级不会覆盖；改完保存就生效，不用重启。每一项要打开开关才会用，出错时语音和识别会自动退回内置方式。' },
          h('div', { className: 'ab-flex' },
            h('code', { className: 'ab-small', style: { wordBreak: 'break-all', flex: 1 } }, st ? st.dir : '…'),
            h(Btn, { small: true, onClick: () => post('/local/open').then((r) => toast(r.message)) }, '打开文件夹'))),
        !st ? h(Empty, { icon: '⏳', text: '加载中…' }) : st.list.map((x) => h(Card, { key: x.slot, title: x.title + '（' + x.file + '）', right: f.sw('local.' + x.slot) },
          h('div', { className: 'ab-flex', style: { marginBottom: 8 } },
            h('span', { className: 'ab-small', style: { color: x.active ? 'var(--ab-ok)' : 'var(--ab-muted)' } },
              x.active ? '● 正在由本地脚本接管' : !x.exists ? '还没有这个脚本' : !x.enabled ? '脚本已经有了，开关没开（用内置方式）' : '用内置方式'),
            x.last ? h('span', { className: 'ab-small', style: { color: x.last.ok ? 'var(--ab-ok)' : 'var(--ab-err)' } }, ' · 上次' + (x.last.ok ? '成功，' + x.last.message : '出错：' + x.last.message)) : null),
          h('div', { className: 'ab-flex' },
            x.exists ? null : h(Btn, { small: true, kind: 'primary', disabled: !!busy, onClick: () => act('/local/template', x.slot, 't') }, '生成模板'),
            h(Btn, { small: true, onClick: () => { navigator.clipboard.writeText(x.prompt); toast('复制好了，粘给 DSH，再把【】里那句换成你的情况', 'ok') } }, '复制给 DSH 的话'),
            x.exists && (x.slot === 'tts' || x.slot === 'image') ? h(Btn, { small: true, disabled: !!busy, onClick: () => act('/local/test', x.slot, 'x') }, busy === x.slot + 'x' ? '正在试…' : '试一下') : null),
          x.slot === 'image' && img ? h('img', { src: 'data:image/png;base64,' + img, style: { marginTop: 10, maxWidth: 240, borderRadius: 8 } }) : null)),
      )
    }

    // ---------------- 扩展：模块 ----------------
    const MOD_STATE = (m) => {
      if (m.safeSkipped) return { cls: 'dim', text: '安全模式，没加载' }
      if (!m.enabled) return { cls: 'dim', text: '关着' }
      if (m.running === 'user' && m.builtin) return { cls: 'mine', text: '用的是你的版本' }
      if (m.running === 'user') return { cls: 'mine', text: '在跑' }
      if (m.running === 'builtin' && m.fallback) return { cls: 'warn', text: '你的版本没加载成功，先用内置的' }
      if (m.running === 'builtin') return { cls: '', text: '在跑' }
      return { cls: 'err', text: m.error ? '没加载成功' : '没在跑' }
    }

    /** 一个模块一行：开关、状态、报错，能复制来改 / 用回内置的 / 重新加载。 */
    function ModuleRow({ m, draft, setModules, toast, reload }) {
      const s = MOD_STATE(m)
      const [open, setOpen] = useState(false)
      const setMod = async (patch) => {
        const r = await post('/save', { modules: { [m.id]: { ...((draft.modules || {})[m.id] || {}), ...patch } } })
        if (r.ok === false) return toast(r.message, 'err')
        toast(patch.enabled === false ? `「${m.name}」关掉了` : patch.enabled ? `「${m.name}」打开了` : '好了', 'ok')
        setModules(r.modules)
        reload()
      }
      const act = async (path, body, okMsg) => {
        const r = await post(path, body)
        toast(r.message || okMsg, r.ok === false ? 'err' : 'ok')
        if (r.list) setModules(r.list)
        if (r.prompt && r.ok) copy(r.prompt, toast)
        reload()
        return r
      }
      const what = [m.tools.length ? '工具：' + m.tools.join('、') : '', m.commands.length ? '命令：' + m.commands.map((c) => '/' + c).join(' ') : ''].filter(Boolean).join('　')
      const errs = (m.error ? [{ label: '加载', message: m.error }] : []).concat(m.errors || [])
      return h('div', { className: 'ab-mod' },
        h('div', { className: 'main' },
          h('div', { className: 'nm' }, m.name, h('code', null, m.id),
            h('span', { className: cx('ab-badge', s.cls) }, s.text),
            m.outdated ? h('span', { className: 'ab-badge warn', title: '你复制 / 替换时内置的是 ' + m.forkedFrom + '，现在是 ' + m.builtinVersion }, '内置版本更新了') : null),
          m.description ? h('div', { className: 'ds' }, m.description) : null,
          what ? h('div', { className: 'what' }, what) : null,
          errs.length ? h('div', { className: 'ab-note err', style: { marginTop: 6 } },
            h('div', { style: { cursor: 'pointer' }, onClick: () => setOpen(!open) }, (open ? '▾ ' : '▸ ') + errs.length + ' 条报错：' + String(errs[0].message).split('\n')[0].slice(0, 120)),
            open ? h('div', { className: 'ab-code' }, errs.map((e) => (e.at ? new Date(e.at).toLocaleTimeString() + ' ' : '') + (e.label || '') + '：' + e.message).join('\n\n')) : null) : null,
          h('div', { className: 'acts' },
            m.builtin && !m.hasUser ? h(Btn, { small: true, onClick: () => act('/modules/fork', { id: m.id }, '复制好了'), title: '把这个内置模块的源码复制到 modules/' + m.id + '/，改了就替换内置的' }, '复制一份来改') : null,
            m.hasUser ? h(Btn, { small: true, onClick: () => post('/modules/open?id=' + encodeURIComponent(m.id)).then((r) => toast(r.message)) }, '打开文件夹') : null,
            m.hasUser ? h(Btn, { small: true, onClick: () => get('/modules/prompt?id=' + encodeURIComponent(m.id)).then((r) => copy(r.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的')) }, '复制给 DSH 的话') : null,
            m.hasUser && !m.safeSkipped ? h(Btn, { small: true, onClick: () => act('/modules/reload', { id: m.id }, '重新加载好了') }, '重新加载') : null)),
        h('div', { className: 'side' },
          h(Switch, { on: m.enabled, onChange: (v) => setMod({ enabled: v }), title: m.enabled ? '关掉这个模块' : '打开这个模块' }),
          m.builtin && m.hasUser ? h('label', { className: 'ab-small ab-muted', style: { display: 'flex', alignItems: 'center', gap: 6 } }, '用内置的', h(Switch, { on: m.useBuiltin, onChange: (v) => setMod({ useBuiltin: v }) })) : null))
    }

    /** 模拟测试：不上 QQ 试模块。发出去的只截下来看，不真发。 */
    function Simulate({ toast }) {
      const [as, setAs] = useState('owner')
      const [kind, setKind] = useState('private')
      const [text, setText] = useState('')
      const [reply, setReply] = useState('')
      const [out, setOut] = useState(null)
      const [tools, setTools] = useState([])
      const [tool, setTool] = useState('')
      const [args, setArgs] = useState('{}')
      const [tout, setTout] = useState(null)
      useEffect(() => { get('/modules/tools?as=' + as + '&kind=' + kind).then((r) => { const l = r.list || []; setTools(l); if (!l.some((t) => t.name === tool)) setTool(l[0] ? l[0].name : '') }) }, [as, kind])
      const cur = tools.find((t) => t.name === tool)
      const run = async () => { const r = await post('/modules/simulate', { as, kind, text, reply }); if (r.ok === false) return toast(r.message, 'err'); setOut(r) }
      const call = async () => {
        let a
        try { a = JSON.parse(args || '{}') } catch (e) { return toast('参数要是 JSON，比如 {"city":"北京"}', 'err') }
        const r = await post('/modules/tool', { as, kind, name: tool, args: a })
        if (r.ok === false) return toast(r.message, 'err')
        setTout(r)
      }
      const sentList = (sent) => (sent && sent.length ? h('div', { className: 'ab-code' }, sent.map((s) => '→ ' + s.chatId + '：' + s.text).join('\n')) : h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '没有发出任何消息'))
      return h(Card, { title: '模拟测试', desc: '不用上 QQ 就能试模块：这里发出去的消息只截下来显示，不会真发到 QQ。（模块直接调 api.onebot 的操作，比如禁言，是真的会执行的；会改设置的内置命令不执行。）' },
        h(Row, { label: '假装是', hint: '谁在说话、在哪儿说' },
          h('div', { className: 'ab-flex' },
            h(Seg, { value: as, options: [{ value: 'owner', label: '主人' }, { value: 'other', label: '别人' }], onChange: setAs }),
            h(Seg, { value: kind, options: [{ value: 'private', label: '私聊' }, { value: 'group', label: '群聊' }], onChange: setKind }))),
        h(Row, { label: '发一条消息', hint: '看哪个模块接管、命令回什么（/开头是命令）' },
          h('input', { className: 'ab-input', value: text, placeholder: '比如：早安，或 /weather 北京', onChange: (e) => setText(e.target.value) })),
        h(Row, { label: '她的回复', hint: '可选：假设她这样回，看经过各个模块改写后最后发出去什么（可以用 ||| 分条、<voice>…</voice>）' },
          h('input', { className: 'ab-input', value: reply, placeholder: '比如：早呀|||今天也要加油', onChange: (e) => setReply(e.target.value) })),
        h('div', { className: 'ab-flex' }, h(Btn, { kind: 'primary', small: true, disabled: !text.trim() && !reply.trim(), onClick: run }, '模拟')),
        out ? h('div', { style: { marginTop: 8 } }, out.steps.map((s, i) => h('div', { key: i, className: 'ab-small' }, '· ' + s)), sentList(out.sent)) : null,
        h('div', { className: 'ab-section-title' }, '调用工具'),
        tools.length ? h('div', null,
          h(Row, { label: '工具', hint: cur ? cur.description : '' }, h(Select, { value: tool, options: tools.map((t) => ({ value: t.name, label: t.name })), onChange: (v) => { setTool(v); setArgs('{}'); setTout(null) } })),
          cur && cur.parameters && Object.keys(cur.parameters.properties || {}).length ? h('div', { className: 'ab-small ab-muted', style: { margin: '0 0 6px' } }, '参数：' + Object.entries(cur.parameters.properties).map(([k, v]) => k + (v.description ? '（' + v.description + '）' : '')).join('；')) : null,
          h('textarea', { className: 'ab-textarea', style: { minHeight: 50, fontFamily: 'ui-monospace,Consolas,monospace' }, value: args, onChange: (e) => setArgs(e.target.value) }),
          h('div', { className: 'ab-flex', style: { marginTop: 6 } }, h(Btn, { small: true, onClick: call, disabled: !tool }, '调用')),
          tout ? h('div', null, h('div', { className: 'ab-code' }, JSON.stringify(tout.result, null, 2)), sentList(tout.sent)) : null)
          : h('div', { className: 'ab-small ab-muted' }, '这个场合没有工具'))
    }

    /** 扩展页：所有模块（内置的 + 自己写的）、新建、安全模式。 */
    function Modules({ st, draft, setDraft, toast, reload }) {
      const [data, setData] = useState(null)
      const [newId, setNewId] = useState('')
      const [newName, setNewName] = useState('')
      const load = () => get('/modules').then(setData)
      useEffect(() => { load() }, [])
      useEffect(() => { if (data && st.modules) setData((d) => ({ ...d, list: st.modules })) }, [JSON.stringify(st.modules)])
      const setModules = (list) => list && setData((d) => ({ ...d, list }))
      if (!data) return h(Empty, { icon: '⏳', text: '加载中…' })
      const list = data.list || []
      const builtin = list.filter((m) => m.builtin)
      const mine = list.filter((m) => !m.builtin)
      const props = { draft, setModules, toast, reload: () => { reload(); load() } }
      const create = async () => {
        const r = await post('/modules/create', { id: newId.trim(), name: newName.trim() })
        if (!r.ok) return toast(r.message, 'err')
        setNewId(''); setNewName('')
        setModules(r.list)
        copy(r.prompt, toast, '建好了，「复制给 DSH 的话」已经复制好，粘给 DSH 让它帮你写')
        reload()
      }
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '扩展', desc: '她的每项本事都是一个模块：能单独关掉；能复制一份来改，改了就替换内置的；也能自己写新模块，让她学会你想要的任何事。自己写的东西放在下面这个文件夹，插件升级不会动；改完保存几秒内自动生效，不用重启。不会写代码？点「复制给 DSH 的话」，粘给 DSH，说你想要什么。' },
          h('div', { className: 'ab-flex' },
            h('code', { className: 'ab-small', style: { wordBreak: 'break-all', flex: 1 } }, data.dir),
            h(Btn, { small: true, onClick: () => post('/modules/open').then((r) => toast(r.message)) }, '打开文件夹'),
            h(Btn, { small: true, onClick: () => copy(data.prompt, toast, '复制好了，粘给 DSH，把【】里那句换成你想要的') }, '复制给 DSH 的话'),
            h(Btn, { small: true, kind: 'ghost', onClick: async () => { const r = await post('/modules/reload', {}); setModules(r.list); toast(r.message) } }, '重新检查')),
          h(Row, { label: '安全模式', hint: '打开后你写的模块一个都不加载，内置的全部恢复。出了问题先开它，看是不是你的模块引起的。' },
            h(Switch, { on: st.config.safeMode, onChange: async (v) => { const r = await post('/save', { safeMode: v }); toast(v ? '安全模式开了：只跑内置模块' : '安全模式关了', 'ok'); setModules(r.modules); reload() } })),
          st.config.safeMode ? h('div', { className: 'ab-note warn' }, '安全模式开着：你写的模块现在都没加载。') : null),
        h(Card, { title: '新建一个模块', desc: '从模板建一个能直接跑的例子（关键词自动回复 + 一个命令 + 一个工具），在它上面改。id 用小写英文，比如 weather。想改内置的本事，用下面内置模块那一行的「复制一份来改」。' },
          h('div', { className: 'ab-flex' },
            h('input', { className: 'ab-input', style: { maxWidth: 180 }, placeholder: 'id，如 weather', value: newId, onChange: (e) => setNewId(e.target.value.toLowerCase()) }),
            h('input', { className: 'ab-input', placeholder: '名字，如 查天气', value: newName, onChange: (e) => setNewName(e.target.value) }),
            h(Btn, { kind: 'primary', small: true, disabled: !newId.trim(), onClick: create }, '新建'))),
        mine.length ? h(Card, { title: '自己写的（' + mine.length + '）' }, h('div', null, mine.map((m) => h(ModuleRow, { key: m.id, m, ...props })))) : null,
        h(Card, { title: '内置模块（' + builtin.length + '）', desc: '关掉的模块：她就没有这项本事，相关的标签页也会藏起来。连接、权限、人格、聊天这些是核心，不能关。' },
          h('div', null, builtin.map((m) => h(ModuleRow, { key: m.id, m, ...props })))),
        h(Simulate, { toast }),
      )
    }

    /** 自己写的模块的面板：自动表单 + 模块自己的 panel.js。 */
    class PanelBoundary extends React.Component {
      constructor(p) { super(p); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      render() { return this.state.error ? h('div', { className: 'ab-note err' }, '这个模块的面板出错了：' + String((this.state.error && this.state.error.message) || this.state.error)) : this.props.children }
    }
    function ExtPanel({ m, settings, toast, reload }) {
      const [Comp, setComp] = useState(null)
      const [err, setErr] = useState('')
      useEffect(() => {
        let alive = true
        fetch(API + '/modules/panel?id=' + encodeURIComponent(m.id) + '&t=' + Date.now(), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error('读不到 panel.js')))).then((src) => {
          const call = (p, body) => (body === undefined ? get('/ext/' + m.id + p) : post('/ext/' + m.id + p, body))
          const ui = { Card, Btn, Switch, Row, Empty, Select, Seg, Range }
          const C = new Function('React', 'h', 'ui', 'call', src)(React, h, ui, call)
          if (typeof C !== 'function') throw new Error('panel.js 最后要 return 一个组件（函数）')
          if (alive) setComp(() => C)
        }).catch((e) => alive && setErr(e.message))
        return () => { alive = false }
      }, [m.id, m.startedAt])
      if (err) return h('div', { className: 'ab-note err' }, '面板加载失败：' + err)
      if (!Comp) return h(Empty, { icon: '⏳', text: '加载中…' })
      const save = async (patch) => { const r = await post('/save', { ext: { [m.id]: patch } }); toast(r.ok === false ? r.message : '保存好了', r.ok === false ? 'err' : 'ok'); reload() }
      return h(PanelBoundary, null, h(Comp, { settings, save, toast, reload }))
    }
    function ExtPage({ st, draft, setDraft, toast, reload, mod, embedded }) {
      const m = (st.modules || []).find((x) => x.id === mod)
      const f = useField(draft, setDraft)
      if (!m) return h(Empty, { icon: '🧩', text: '这个模块没在跑了' })
      const base = 'ext.' + m.id + '.'
      const settings = { ...(m.defaults || {}), ...((st.config.ext || {})[m.id] || {}) }
      const field = (s) => {
        const p = base + s.key
        if (s.type === 'switch') return f.sw(p)
        if (s.type === 'number') return f.num(p, { min: s.min, max: s.max, step: s.step })
        if (s.type === 'select') return f.select(p, (s.options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o)))
        if (s.type === 'textarea') return h('textarea', { className: 'ab-textarea', value: getPath(draft, p) ?? '', placeholder: s.placeholder, onChange: (e) => setDraft(setPath(draft, p, e.target.value)) })
        if (s.type === 'password') return f.text(p, { type: 'password', placeholder: getPath(draft, p + 'Set') ? '已保存（不改就留空）' : s.placeholder || '' })
        return f.text(p, { placeholder: s.placeholder })
      }
      return h('div', { className: 'ab-grid' },
        h(Card, { title: m.name, desc: m.description, right: h('span', { className: 'ab-badge mine' }, embedded ? '扩展模块 · ' + m.id : m.id) },
          (m.settings || []).map((s) => h(Row, { key: s.key, label: s.label || s.key, hint: s.hint }, field(s))),
          (m.settings || []).length ? h('div', { className: 'ab-small ab-muted' }, '改完点下面的「保存设置」。') : null,
          (m.errors || []).length ? h('div', { className: 'ab-note err', style: { marginTop: 8 } }, '最近的报错：' + m.errors[0].message) : null),
        m.panel ? h(ExtPanel, { m, settings, toast, reload }) : null)
    }

    const BILI_KIND = { watch: '看了', comment: '评论', reply: '回复', share: '分享给你', error: '没成功' }

    /** B 站：登录、定时刷、评论 / 回复、分享给主人，以及她刷过什么。 */
    function Bili({ draft, setDraft, toast }) {
      const f = useField(draft, setDraft)
      const [s, setS] = useState(null)
      const [busy, setBusy] = useState('')
      const load = () => get('/bili/state').then(setS)
      useEffect(() => { load() }, [])
      const act = (path, label) => async () => { setBusy(label); const r = await post(path); setBusy(''); toast(r.message, r.ok ? 'ok' : 'err'); load() }
      const acct = s && s.account
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '刷 B 站', right: f.sw('bili.enabled'), desc: '她会定时去 B 站刷几个视频：从她的兴趣、记忆里你喜欢的东西和下面的关键词里挑方向去搜，读简介、字幕和热评，再按自己的性格决定评不评论、要不要私聊分享给你、记住什么。看过的、评过的都记成她的经历，聊天时会自然提起。你在 QQ 里发 B 站链接或分享卡片，她也能点进去看完再聊。' },
          h(BiliCookie, { draft, setDraft }),
          h('div', { className: 'ab-flex', style: { marginTop: 4 } },
            h(Btn, { small: true, onClick: async () => { const r = await get('/bili/account'); setS({ ...(s || {}), account: r }) } }, '检查登录'),
            acct ? h('span', { className: 'ab-small', style: { color: acct.isLogin ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, acct.isLogin ? '已登录：' + acct.uname : '没登录（只能看，不能评论）') : null),
        ),
        h(Card, { title: '怎么刷', desc: '只在「主动搭话」里设的醒着时间内刷。' },
          h(Row, { label: '定时自己去刷' }, f.sw('bili.autoBrowse')),
          h(Row, { label: '多久刷一轮' }, f.range('bili.intervalHours', 1, 24, 1, (v) => v + ' 小时')),
          h(Row, { label: '每天最多刷' }, f.range('bili.maxRunsPerDay', 0, 12, 1, (v) => v + ' 轮')),
          h(Row, { label: '一轮看几个视频' }, f.range('bili.perRun', 1, 6, 1, (v) => v + ' 个')),
          h(Row, { label: '额外想看的方向', hint: '一行一个；另外还会参考她的兴趣和记忆' }, f.list('bili.keywords', { placeholder: '白米饭 做法\n猫咪\n游戏解说' })),
          h(Row, { label: '播放量门槛' }, f.num('bili.minViews', { min: 0 }), h('span', { className: 'ab-muted' }, '次以上')),
          h(Row, { label: '只看最近' }, f.num('bili.maxAgeDays', { min: 0 }), h('span', { className: 'ab-muted' }, '天内发的（0 = 不限）')),
        ),
        h(Card, { title: '评论、回复和分享', desc: '评论和回复要登录。试运行开着时只记日志不发。' },
          h(Row, { label: '主人 B 站昵称', hint: '可选；用于解析评论中的 @主人，不能用 QQ 称呼代替。' }, f.text('bili.ownerName', { placeholder:'留空则不解析 @主人' })),
          h(Row, { label: '主人 B 站 MID', hint: '可选；填写时请与上面的昵称对应。留空时只接受唯一的精确昵称匹配。' }, f.text('bili.ownerMid', { placeholder:'数字 MID，可留空' })),
          h(Row, { label: '自己发评论' }, f.sw('bili.comment'), h('span', { className: 'ab-muted' }, '每天最多'), f.num('bili.maxCommentsPerDay', { min: 0, max: 50 }), h('span', { className: 'ab-muted' }, '条')),
          h(Row, { label: '回别人回她的评论' }, f.sw('bili.reply'), h('span', { className: 'ab-muted' }, '每天最多'), f.num('bili.maxRepliesPerDay', { min: 0, max: 100 }), h('span', { className: 'ab-muted' }, '条')),
          h(Row, { label: '看到好玩的分享给你', hint: '私聊发给主人，带视频链接' }, f.sw('bili.shareToOwner')),
          h(Row, { label: '顺手点赞' }, f.sw('bili.like')),
        ),
        h(Card, { title: '她刷过什么', right: h('div', { className: 'ab-flex' },
          h(Btn, { small: true, onClick: act('/bili/replies', 'replies'), disabled: !!busy }, busy === 'replies' ? '正在看…' : '看看有没有人回她'),
          h(Btn, { small: true, kind: 'primary', onClick: act('/bili/run', 'run'), disabled: !!busy }, busy === 'run' ? h(Fragment, null, h('i', { className: 'ab-spin' }), ' 正在刷…') : '现在刷一轮')) },
          s && s.pauseReason ? h('div', { className: 'ab-note warn', style: { marginBottom: 8 } }, '今天先不发评论和回复了：' + s.pauseReason + '（明天自动恢复；Cookie 过期的话重新复制一份填上）') : null,
          s ? h('div', { className: 'ab-muted ab-small', style: { marginBottom: 8 } }, '今天自动刷了 ' + s.runs + ' 轮 · 评论 ' + s.comments + ' 条 · 回复 ' + s.replies + ' 条' + (s.lastRun ? ' · 上次 ' + timeAgo(s.lastRun) : '') + '（手动刷不占次数）') : null,
          !s ? h(Empty, { icon: '⏳', text: '加载中…' }) : s.history.length === 0 ? h(Empty, { icon: '📺', text: '还没刷过。点「现在刷一轮」试试。' }) :
            h('div', { className: 'ab-list' }, s.history.map((x, i) => h('div', { key: i, className: 'ab-li' },
              h('div', { className: 'meta' }, timeAgo(x.at), h('br'), BILI_KIND[x.kind] || x.kind),
              h('div', { className: 'body' }, x.bvid ? h('a', { href: 'https://www.bilibili.com/video/' + x.bvid, target: '_blank', rel: 'noreferrer' }, '《' + x.title + '》') : h('b', null, '《' + x.title + '》'), x.text ? h('div', { className: 'ab-muted' }, x.text) : null)))),
        ),
      )
    }

// ---------------- 生图：服务（多个协议）+ 任务工作台 ----------------
    const IMG_PROTOCOLS = [
      { value: 'openai', label: 'OpenAI 兼容', desc: '/images/generations + /images/edits：OpenAI、硅基流动、各家中转' },
      { value: 'gemini', label: 'Gemini 原生', desc: 'generateContent，能看多张参考图' },
      { value: 'comfyui', label: 'ComfyUI 工作流', desc: '自己的工作流，按节点绑定输入' },
      { value: 'http', label: '自己配的 HTTP', desc: '任意服务：请求/返回格式自己填（同步或异步）' },
    ]
    const IMG_MODES = [{ value: 'text', label: '文生图' }, { value: 'reference', label: '参考图生成' }, { value: 'edit', label: '原图编辑' }, { value: 'mask', label: '蒙版编辑' }]
    const IMG_ROLES = [{ value: 'base', label: '底图' }, { value: 'identity', label: '人物长相' }, { value: 'style', label: '风格' }, { value: 'composition', label: '构图' }]
    const JOB_CLS = { delivered: 'ok', failed: 'err', unknown: 'warn', canceled: 'dim', delivery_pending: 'warn', cancel_requested: 'warn' }
    const newProfile = (n) => ({ id: 'img-' + Date.now().toString(36).slice(-5), name: '生图服务 ' + n, protocol: 'openai', baseUrl: '', apiKey: '', model: '', capabilities: { modes: ['text'], maxInputs: 4, sizes: [] }, extra: {} })

    function ImageGen({ st, draft, setDraft, toast }) {
      const f = useField(draft, setDraft)
      const c = draft.imageGen
      const [open, setOpen] = useState(c.profiles[0] ? c.profiles[0].id : '')
      const setProfiles = (list) => setDraft(setPath(draft, 'imageGen.profiles', list))
      const upd = (i, path, v) => setProfiles(c.profiles.map((p, k) => (k === i ? setPath(p, path, v) : p)))
      return h('div', { className: 'ab-grid' },
        h(Card, { title: '让她画图', right: f.sw('imageGen.enabled'), desc: '聊天里让她画图、照着发来的图画、改图，她会在后台画好直接发出来，聊天不用等。可以接好几个生图服务：她会挑能做这件事的那个（默认的优先）；都做不了就直说，不会悄悄把参考图丢掉改成文生图。' },
          h(Row, { label: '默认服务' }, f.select('imageGen.defaultProfile', c.profiles.map((p) => ({ value: p.id, label: p.name, desc: p.protocol })), { width: 220, placeholder: '先在下面加一个服务' })),
          h(Row, { label: '默认尺寸' }, f.select('imageGen.size', [{ value: '1024x1024', label: '1024 × 1024', desc: '方图' }, { value: '768x1024', label: '768 × 1024', desc: '竖图' }, { value: '1024x768', label: '1024 × 768', desc: '横图' }, { value: '512x512', label: '512 × 512', desc: '小图，更快' }], { width: 200 })),
          h(Row, { label: '画完后在下次对话中查看作品', hint: '仅限同账号、聊天和人格；模型必须支持图片。' }, f.sw('imageGen.observeGenerated')),
          h(Row, { label: '默认画幅' }, f.select('imageGen.shape', [{value:'',label:'按尺寸'},{value:'square',label:'方图'},{value:'portrait',label:'竖图'},{value:'landscape',label:'横图'}])),
          h(Row, { label: '固定风格', hint: '每次画都会加在描述前面' }, f.text('imageGen.stylePrompt', { size: 'wide', placeholder: '例如：日系二次元，柔和光线，蓝白配色' })),
          h(Row, { label: '只给主人画', hint: '关掉后群友也能让她画（会花你的额度）' }, f.sw('imageGen.ownerOnly')),
          h(Row, { label: '每人每天最多', hint: '群友 / 别人每天能让她画几张' }, f.num('imageGen.quota.perUserPerDay', { min: 0, max: 1000 }), h('span', { className: 'ab-muted' }, '张')),
          h(Row, { label: '主人不限个人次数', hint: '聊天和服务总额度仍然生效' }, f.sw('imageGen.quota.ownerUnlimited')),
          h(Row, { label: '每个聊天每日上限' }, f.num('imageGen.quota.perChatPerDay', { min: 0, max: 10000 })),
          h(Row, { label: '每个服务每日上限' }, f.num('imageGen.quota.perProviderPerDay', { min: 0, max: 10000 })),
          h(Row, { label: '等参考图最多', hint: '发来的图还在下载时' }, f.num('imageGen.waitInputSec', { min: 5, max: 300 }), h('span', { className: 'ab-muted' }, '秒')),
          st.config.local && st.config.local.image ? h('div', { className: 'ab-note' }, '「本地接口」里的画图脚本开着：它会被当成一个只会文生图的服务优先使用。') : null,
          !c.enabled ? h('div', { className: 'ab-note', style: { marginTop: 10 } }, '还没开启。加好服务、打开右上角开关并保存后，她就会多一个「画图」能力。') : null,
        ),
        h(Card, { title: '生图服务', desc: '每个服务一种协议。「能力」是你声明这个服务/模型能做什么（会和协议本身能做的取交集）；声明错了，用的时候会被服务拒绝并告诉对方。改完记得保存，再点「检查」。',
          right: h(Btn, { small: true, onClick: () => { const p = newProfile(c.profiles.length + 1); setProfiles([...c.profiles, p]); setOpen(p.id) } }, '＋ 加一个服务') },
          c.profiles.length === 0 ? h(Empty, { icon: '🎨', text: '还没有生图服务' }) : c.profiles.map((p, i) => h('div', { key: p.id, className: 'ab-psec' },
            h('div', { className: 'ab-flex' },
              h('b', null, p.name), h('span', { className: 'ab-badge dim' }, (IMG_PROTOCOLS.find((x) => x.value === p.protocol) || {}).label || p.protocol),
              p.id === c.defaultProfile ? h('span', { className: 'ab-badge' }, '默认') : null,
              h('span', { className: 'ab-muted ab-small' }, (p.capabilities.modes || []).map((m) => (IMG_MODES.find((x) => x.value === m) || {}).label).join('、')),
              h('div', { className: 'ab-spacer' }),
              h(ProfileCheck, { id: p.id, toast }),
              h(Btn, { small: true, kind: 'ghost', onClick: () => setOpen(open === p.id ? '' : p.id) }, open === p.id ? '收起' : '编辑'),
              h(Btn, { small: true, kind: 'danger', onClick: () => { if (confirm('删掉「' + p.name + '」？保存后生效。')) setProfiles(c.profiles.filter((_, k) => k !== i)) } }, '删除')),
            open === p.id ? h(ProfileEditor, { p, upd: (path, v) => upd(i, path, v) }) : null)),
        ),
        h(ImageJobs, { st, toast, draft }),
      )
    }

    function ProfileCheck({ id, toast }) {
      return h(Btn, { small: true, kind: 'ghost', onClick: async () => { const r = await post('/imagegen/test', { id }); toast(r.message, r.ok ? 'ok' : 'err') } }, '检查配置')
    }

    function ProfileEditor({ p, upd }) {
      const x = p.extra || {}
      const txt = (path, props) => h('input', { className: cx('ab-input', props && props.size), value: getPath(p, path) ?? '', placeholder: props && props.placeholder, type: (props && props.type) || 'text', onChange: (e) => upd(path, e.target.value) })
      const json = (path, placeholder) => h(JsonArea, { value: getPath(p, path), onChange: (v) => upd(path, v), placeholder })
      return h('div', { style: { marginTop: 8 } },
        h(Row, { label: '名字' }, txt('name')),
        h(Row, { label: 'ID', hint: '自动生成，用于区分服务' }, h('code', null, p.id)),
        h(Row, { label: '协议' }, h(Select, { value: p.protocol, options: IMG_PROTOCOLS, width: 240, onChange: (v) => upd('protocol', v) })),
        p.protocol !== 'http' ? h(Row, { label: '服务地址', hint: p.protocol === 'gemini' ? '留空 = Google 官方地址' : p.protocol === 'comfyui' ? '例如 http://127.0.0.1:8188' : '一般以 /v1 结尾' }, txt('baseUrl', { size: 'wide', placeholder: p.protocol === 'comfyui' ? 'http://127.0.0.1:8188' : p.protocol === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.siliconflow.cn/v1' })) : null,
        h(Row, { label: 'API Key', hint: '只存在本机，不会显示出来' }, txt('apiKey', { type: 'password', placeholder: p.apiKeySet ? '已保存（不改就留空）' : '没有就留空' })),
        p.protocol === 'openai' || p.protocol === 'gemini' ? h(Row, { label: '模型' }, txt('model', { size: 'wide', placeholder: p.protocol === 'gemini' ? 'gemini-2.5-flash-image' : 'gpt-image-1 / Kwai-Kolors/Kolors' })) : null,
        h(Row, { label: '能做什么', hint: '按这个服务 / 模型实际支持的勾' },
          h('div', { className: 'ab-flex' }, IMG_MODES.map((m) => h('label', { key: m.value, className: 'ab-small' }, h('input', { type: 'checkbox', checked: (p.capabilities.modes || []).includes(m.value), onChange: (e) => upd('capabilities.modes', e.target.checked ? [...(p.capabilities.modes || []), m.value] : (p.capabilities.modes || []).filter((k) => k !== m.value)) }), ' ' + m.label)))),
        h(Row, { label: '最多几张输入图' }, h('input', { className: 'ab-input sm', type: 'number', min: 0, max: 16, value: p.capabilities.maxInputs ?? 4, onChange: (e) => upd('capabilities.maxInputs', Number(e.target.value)) })),
        h(Row, { label: '只支持这些尺寸', hint: '一行一个，留空 = 不限制' }, h(ListArea, { value: p.capabilities.sizes || [], onChange: (v) => upd('capabilities.sizes', v), placeholder: '1024x1024' })),
        p.protocol === 'openai' ? [
          h(Row, { key: 'rf', label: '返回格式', hint: '有的中转不认这个字段，就选「不发」' }, h(Select, { value: x.responseFormat || '', width: 200, options: [{ value: '', label: '不发这个字段' }, { value: 'b64_json', label: 'b64_json' }, { value: 'url', label: 'url' }], onChange: (v) => upd('extra.responseFormat', v) })),
          h(Row, { key: 'if', label: '多图字段名', hint: '编辑接口上传多张图时用的字段' }, h(Select, { value: x.imageField || '', width: 200, options: [{ value: '', label: '自动（多张用 image[]）' }, { value: 'image', label: 'image' }, { value: 'image[]', label: 'image[]' }], onChange: (v) => upd('extra.imageField', v) })),
        ] : null,
        p.protocol === 'gemini' ? h(Row, { label: '默认画幅', hint: '没指定尺寸时用' }, h(Select, { value: x.aspectRatio || '', width: 160, options: [{ value: '', label: '模型默认' }, ...['1:1', '3:4', '4:3', '9:16', '16:9'].map((v) => ({ value: v, label: v }))], onChange: (v) => upd('extra.aspectRatio', v) })) : null,
        p.protocol === 'comfyui' ? [
          h(Row, { key: 'wf', label: '工作流（API 格式）', hint: 'ComfyUI 里「保存（API 格式）」导出的 JSON' }, json('extra.workflow', '{ "3": { "class_type": "KSampler", "inputs": { … } } }')),
          h(Row, { key: 'bd', label: '输入绑定', hint: '节点ID.inputs.字段：prompt / negativePrompt / width / height / seed / base / identity / style / composition / mask' }, json('extra.bindings', '{ "prompt": "6.inputs.text", "base": "10.inputs.image" }')),
        ] : null,
        p.protocol === 'http' ? [
          h(Row, { key: 'sb', label: '提交请求', hint: 'method / url / bodyType（json/form/multipart/none）/ body 模板；占位符 {prompt} {size} {width} {height} {apiKey} {imagesJson}（图片对象数组）{imagesDataUrls}（data URL 数组）{maskBase64}' }, json('extra.submit', '{ "method": "POST", "url": "https://…/generate", "bodyType": "json", "body": "{\\"prompt\\":\\"{prompt}\\"}" }')),
          h(Row, { key: 'rs', label: '返回', hint: 'kind: image（直接是图）/ json；imagesPath 图在哪；taskIdPath 有就是异步' }, json('extra.response', '{ "kind": "json", "imagesPath": "data.0.b64" }')),
          h(Row, { key: 'st', label: '查进度（异步才要）', hint: 'url 或 body 用 {taskId}；支持 method / bodyType / body；statePath / doneValues / failedValues / imagesPath / errorPath' }, json('extra.status', '{ "url": "https://…/tasks/{taskId}", "statePath": "status", "doneValues": ["done"], "failedValues": ["failed"], "imagesPath": "images" }')),
          h(Row, { key: 'cc', label: '取消（可选）' }, json('extra.cancel', '{ "method": "POST", "url": "https://…/tasks/{taskId}/cancel" }')),
          h(Row, { key: 'hd', label: '请求头', hint: '例如 {"Authorization": "Bearer {apiKey}"}' }, json('extra.headers', '{ "Authorization": "Bearer {apiKey}" }')),
        ] : null,
      )
    }

    /** 非法 JSON 也交给草稿保存为字符串，让保存校验能阻止丢失编辑内容。 */
    function JsonArea({ value, onChange, placeholder, array = false }) {
      const show = (v) => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2))
      const [text, setText] = useState(show(value))
      const [bad, setBad] = useState(typeof value === 'string' && value !== '')
      useEffect(() => { try { if (JSON.stringify(JSON.parse(text || 'null')) !== JSON.stringify(value ?? null)) setText(show(value)) } catch (e) {} }, [JSON.stringify(value)])
      return h('div', { style: { width: '100%' } },
        h('textarea', { className: 'ab-textarea', style: { minHeight: 90, fontFamily: 'var(--dsh-font-family-mono, monospace)', borderColor: bad ? 'var(--ab-err)' : undefined }, placeholder, value: text,
          onChange: (e) => { setText(e.target.value); if (!e.target.value.trim()) { setBad(false); return onChange(array ? [] : null) } try { const parsed = JSON.parse(e.target.value); const valid = array ? Array.isArray(parsed) : parsed && typeof parsed === 'object' && !Array.isArray(parsed); onChange(valid ? parsed : e.target.value); setBad(!valid) } catch (err) { onChange(e.target.value); setBad(true) } } }),
        bad ? h('div', { className: 'ab-small', style: { color: 'var(--ab-err)' } }, '请输入合法的 JSON '+(array?'数组':'对象')+'，修正后才能保存设置') : null)
    }

    const assetUrl = (id) => API + '/imagegen/asset?id=' + encodeURIComponent(id)
    const galleryAssetUrl = (item, chatId, personaId) => API + '/imagegen/gallery/asset?' + new URLSearchParams({ id: item.galleryId || item.id, chatId, personaId })

    function ArtworkGallery({ st, chats, onReuse, toast }) {
      const [chatId, setChatId] = useState('private:' + st.config.ownerQQ)
      const [page, setPage] = useState(null)
      const [busy, setBusy] = useState(false)
      const seq = useRef(0)
      const load = async (before = '', previous = null) => {
        const request = ++seq.current
        setBusy(true)
        try {
          const q = { chatId }; if (before) { q.before = before; q.personaId = previous.scope.personaId }
          const r = await get('/imagegen/gallery?' + new URLSearchParams(q))
          if (request !== seq.current) return
          if (!r.ok) { setPage(null); toast(r.message || '图库读取失败', 'err'); return }
          setPage(previous ? { ...r, items: [...previous.items, ...r.items] } : r)
        } catch { if (request === seq.current) { setPage(null); toast('图库读取失败', 'err') } }
        finally { if (request === seq.current) setBusy(false) }
      }
      useEffect(() => { setPage(null); load(); return () => { seq.current++ } }, [chatId])
      return h(Card, { title: '作品图库', desc: '按当前账号、目标聊天、人设和主人请求分别浏览已送达作品。作品 ID 绑定原任务和图片；复用时会再次核验。',
        right: h(Btn, { small: true, disabled: busy, onClick: () => load() }, '刷新') },
        h(Row, { label: '聊天范围' }, h(Select, { value: chatId, options: chats.map(c => ({ value: c, label: c })), onChange: setChatId })),
        page?.scope ? h('div', { className: 'ab-small ab-muted' }, '当前人设：' + page.scope.personaId) : null,
        !page ? h(Empty, { text: busy ? '加载图库…' : '图库不可用' }) : !page.items.length ? h(Empty, { text: '此范围还没有作品' }) :
          h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 12, marginTop: 10 } }, page.items.map(item =>
            h('figure', { key: item.id, style: { margin: 0, width: 170 } },
              h('img', { src: galleryAssetUrl(item, chatId, page.scope.personaId), alt: '作品 ' + item.id, style: { width: 160, height: 160, objectFit: 'contain', borderRadius: 8 } }),
              h('figcaption', { className: 'ab-small' }, item.prompt || '无描述', h('div', { className: 'ab-muted', style: { overflowWrap: 'anywhere' } }, item.id)),
              h(Btn, { small: true, onClick: () => onReuse(item, page.scope) }, '带入新任务')))),
        page?.nextCursor ? h(Btn, { small: true, disabled: busy, onClick: () => load(page.nextCursor, page) }, busy ? '加载中…' : '加载更多') : null)
    }

    /** 任务工作台：新建（文生图 / 参考图 / 改图 / 蒙版）+ 任务列表。 */
    function ImageJobs({ st, toast, draft }) {
      const [jobs, setJobs] = useState(null)
      const [sel, setSel] = useState('')
      const [busy, setBusy] = useState(false)
      const [loadError, setLoadError] = useState('')
      const load = () => get('/imagegen/jobs?limit=40').then((r) => { if (!r.ok) return setLoadError(r.message || '任务列表暂时读不到'); setLoadError(''); setJobs(r.list || []) }).catch(() => setLoadError('任务列表暂时读不到，请刷新重试'))
      useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])
      const [form, setForm] = useState(() => {
        let imported = null
        try { imported = JSON.parse(sessionStorage.getItem('aurabot.imageReference')); sessionStorage.removeItem('aurabot.imageReference') } catch {}
        const valid = imported?.account === st.config.botQQ && imported.reference?.assetId
        return { prompt: '', refs: valid ? [imported.reference] : [], maskAssetId: '', size: '', shape: '', profileId: '', chatId: valid ? imported.chatId : 'private:' + st.config.ownerQQ, parentJobId: '' }
      })
      const [maskFor, setMaskFor] = useState(null) // 正在画蒙版的底图 assetId
      const chats = Array.from(new Set(['private:' + st.config.ownerQQ, ...(st.config.allow.groups || []).map((g) => 'group:' + g), ...(st.config.allow.private || []).map((q) => 'private:' + q)]))
      const upload = async (file, role) => {
        if (file.size > 30 * 1024 * 1024) return toast('图片不能超过 30 MB', 'err')
        const data = await new Promise((res, reject) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => reject(new Error('读取图片失败')); fr.readAsDataURL(file) })
        const r = await post('/imagegen/upload', { data })
        if (!r.ok) return toast(r.message, 'err')
        setForm((f) => ({ ...f, refs: [...f.refs, { assetId: r.assetId, role }] }))
      }
      const fileRef = useRef(null)
      const submit = async () => {
        if (busy) return
        setBusy(true)
        try {
          const r = await post('/imagegen/submit', form)
          if (!r.ok) return toast(r.message, 'err')
          toast('任务已登记', 'ok')
          setForm({ ...form, prompt: '', refs: [], maskAssetId: '', parentJobId: '' })
          setSel(r.job.id)
          load()
        } catch (error) { toast('提交未收到确认，请先刷新任务列表核对，避免重复下单', 'err') }
        finally { setBusy(false) }
      }
      const editFrom = (j) => {
        const profileId=form.profileId||j.input?.profileId||st.config.imageGen.defaultProfile
        const profile=st.config.imageGen.profiles.find(p=>p.id===profileId)
        const referenceOnly=profile?.capabilities?.modes?.includes('reference')&&!profile.capabilities.modes.includes('edit')
        setForm({ ...form, profileId, prompt: '', refs: [{ assetId: j.output.assetIds[0], role: referenceOnly?'identity':'base' }], maskAssetId: '', parentJobId: j.id, chatId: j.chatId })
        toast(referenceOnly?'已经放入参考图；当前服务支持参考再生成，请填写新画面要求':'已经放入底图，请填写修改要求', 'ok')
      }
      const reuseArtwork = (item, scope) => {
        const profileId = form.profileId || st.config.imageGen.defaultProfile
        const profile = st.config.imageGen.profiles.find(p => p.id === profileId)
        const referenceOnly = profile?.capabilities?.modes?.includes('reference') && !profile.capabilities.modes.includes('edit')
        if (form.refs.length) return toast('请先移除当前输入图，再选择图库作品', 'err')
        setForm({ ...form, chatId: scope.chatId, refs: [{ galleryId: item.id, assetId: item.assetId, personaId: scope.personaId, role: referenceOnly ? 'identity' : 'base' }], maskAssetId: '', parentJobId: item.jobId })
        toast(referenceOnly ? '已带入参考图，请填写画面要求' : '已带入底图，请填写修改要求', 'ok')
      }
      const base = form.refs.find((r) => r.role === 'base')
      const profiles = (st.config.imageGen.profiles || []).map((p) => ({ value: p.id, label: p.name, desc: p.protocol }))
      const unsaved = JSON.stringify(draft.imageGen) !== JSON.stringify(st.config.imageGen)
      return h(Fragment, null,
        h(Card, { title: '新任务', desc: '上传参考图并标明用途，有底图时可以涂蒙版指定修改区域。试运行仍会调用生图服务，结果保存在这里；开启实际发送后可补发到 QQ。' },
          unsaved ? h('div', { className: 'ab-note' }, '服务设置有未保存的改动，请先保存再提交任务。') : null,
          h(Row, { label: '画什么 / 怎么改' }, h('textarea', { className: 'ab-textarea', style: { minHeight: 60 }, value: form.prompt, onChange: (e) => setForm({ ...form, prompt: e.target.value }) })),
          h(Row, { label: '画当前角色', hint: '明确画此聊天绑定的角色时开启，冻结当前发布版外观' }, h(Switch, { on: !!form.drawSelf, onChange: v => setForm({ ...form, drawSelf: v }) })),
          h(Row, { label: '输入图', hint: '没有就是文生图' },
            h('div', { style: { width: '100%' } },
              h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 8 } }, form.refs.map((r, i) => h('div', { key: r.assetId + i, className: 'ab-imgref' },
                h('img', { src: r.galleryId ? galleryAssetUrl(r, form.chatId, r.personaId) : assetUrl(r.assetId), alt: '' }),
                h(Select, { value: r.role, options: IMG_ROLES, width: 96, onChange: (v) => setForm({ ...form, refs: form.refs.map((x, k) => (k === i ? { ...x, role: v } : v === 'base' && x.role === 'base' ? { ...x, role: 'identity' } : x)), maskAssetId: v === 'base' || r.role === 'base' ? '' : form.maskAssetId }) }),
                h(Btn, { small: true, kind: 'ghost', onClick: () => setForm({ ...form, refs: form.refs.filter((_, k) => k !== i), maskAssetId: r.role === 'base' ? '' : form.maskAssetId }) }, '去掉')))),
              h('div', { className: 'ab-flex', style: { marginTop: 6 } },
                h(Btn, { small: true, onClick: () => fileRef.current && fileRef.current.click() }, '＋ 上传图片'),
                h('input', { ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' }, onChange: async (e) => { const file = e.target.files && e.target.files[0]; e.target.value = ''; if (file) try { await upload(file, form.refs.some((r) => r.role === 'base') ? 'identity' : 'base') } catch (error) { toast(error.message || '上传失败', 'err') } } }),
                base ? h(Btn, { small: true, kind: form.maskAssetId ? 'primary' : 'ghost', onClick: () => setMaskFor(base.assetId) }, form.maskAssetId ? '已画蒙版（点开改）' : '画蒙版') : null,
                form.maskAssetId ? h(Btn, { small: true, kind: 'ghost', onClick: () => setForm({ ...form, maskAssetId: '' }) }, '不用蒙版') : null))),
          maskFor ? h(MaskPainter, { assetId: maskFor, maskAssetId: form.maskAssetId, toast, onCancel: () => setMaskFor(null), onDone: (id) => { setForm({ ...form, maskAssetId: id }); setMaskFor(null) } }) : null,
          h(Row, { label: '用哪个服务' }, h(Select, { value: form.profileId, width: 220, options: [{ value: '', label: '自动挑（默认的优先）' }, ...profiles], onChange: (v) => setForm({ ...form, profileId: v }) })),
          h(Row, { label: '画幅', hint: '与明确尺寸二选一' }, h(Select, { value: form.shape || '', options: [{value:'',label:'默认'},{value:'square',label:'方图'},{value:'portrait',label:'竖图'},{value:'landscape',label:'横图'}], onChange: v => setForm({...form,shape:v,size:v?'':form.size}) })),
          h(Row, { label: '尺寸' }, h(Select, { value: form.size, width: 200, options: [{ value: '', label: '用默认尺寸' }, { value: '1024x1024', label: '1024 × 1024' }, { value: '768x1024', label: '768 × 1024' }, { value: '1024x768', label: '1024 × 768' }], onChange: (v) => setForm({ ...form, size: v, shape: v ? '' : form.shape }) })),
          h(Row, { label: '发到' }, h(Select, { value: form.chatId, width: 220, options: chats.map((c) => ({ value: c, label: c === 'private:' + st.config.ownerQQ ? '主人私聊' : c.replace('group:', '群 ').replace('private:', '私聊 ') })), onChange: (v) => setForm({ ...form, chatId: v }) })),
          h('div', { className: 'ab-flex' }, form.parentJobId ? h('span', { className: 'ab-muted ab-small' }, '接着改任务 ' + form.parentJobId) : null, h('div', { className: 'ab-spacer' }),
            h(Btn, { kind: 'primary', disabled: busy || unsaved || !form.prompt.trim(), onClick: submit }, busy ? '登记中…' : '开始画'))),
        h(ArtworkGallery, { st, chats, onReuse: reuseArtwork, toast }),
        h(Card, { title: '画图任务', desc: '聊天里和面板里下的画图任务都在这里。画好没发出去的可以重发（不会重新画）；结果不确定的不会自动重画，避免重复扣费。', right: h(Btn, { small: true, kind: 'ghost', onClick: load }, '刷新') },
          loadError ? h('div', { className: 'ab-note err' }, loadError) : null,
          jobs === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : !jobs.length ? h(Empty, { icon: '🖼️', text: '还没有画图任务' }) :
            h('div', { className: 'ab-list' }, jobs.map((j) => h(JobRow, { key: j.id, j, open: sel === j.id, onToggle: () => setSel(sel === j.id ? '' : j.id), toast, reload: load, onEdit: () => editFrom(j) })))),
      )
    }

    function JobRow({ j, open, onToggle, toast, reload, onEdit }) {
      const act = (path, msg) => async () => { const r = await post(path, { id: j.id }); toast(r.message || msg, r.ok ? 'ok' : 'err'); reload() }
      const outs = (j.output && j.output.assetIds) || []
      const ins = (j.lineage && j.lineage.inputs) || (j.input.refs || []).map((r) => ({ assetId: r.assetId, role: r.role }))
      return h('div', { className: 'ab-li', style: { display: 'block' } },
        h('div', { className: 'ab-flex' },
          outs[0] ? h('img', { className: 'ab-thumb', src: assetUrl(outs[0]), alt: '' }) : h('div', { className: 'ab-thumb' }),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'ab-flex' }, h('span', { className: cx('ab-badge', JOB_CLS[j.state]) }, j.stateLabel), h('span', { className: 'ab-muted ab-small' }, j.modeLabel + ' · ' + j.chatId.replace('group:', '群 ').replace('private:', '私聊 ') + ' · ' + timeAgo(j.createdAt))),
            h('div', { className: 'ab-small', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, j.input.prompt),
            j.error ? h('div', { className: 'ab-small', style: { color: 'var(--ab-err)' } }, j.error) : null),
          ['queued', 'waiting_input', 'preparing', 'submitting', 'running', 'retry_wait', 'generated', 'delivery_pending'].includes(j.state) ? h(Btn, { small: true, kind: 'ghost', onClick: act('/imagegen/cancel', '取消了') }, '取消') : null,
          j.state === 'delivery_pending' ? h(Btn, { small: true, disabled: Boolean(j.delivery?.unknown), onClick: act('/imagegen/resend', '在补发了') }, j.delivery?.unknown ? '先核对 QQ 回执' : '补发未发送的图') : null,
          outs.length ? h(Btn, { small: true, kind: 'ghost', onClick: onEdit }, '在这张上改') : null,
          h(Btn, { small: true, kind: 'ghost', onClick: onToggle }, open ? '收起' : '详情')),
        open ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'ab-kv' },
            h('span', null, '任务'), h('span', null, j.id + (j.parentJobId ? '（接着改 ' + j.parentJobId + '）' : '')),
            h('span', null, '谁要的'), h('span', null, j.actorId),
            h('span', null, '服务'), h('span', null, j.profileId || '还没选'),
            h('span', null, '发送回执'), h('span', null, j.delivery?.total ? `已送达 ${j.delivery.delivered} / ${j.delivery.total}，失败 ${j.delivery.failed}，不确定 ${j.delivery.unknown}` + (j.delivery.messageIds.length ? ' · QQ 消息 ' + j.delivery.messageIds.join('、') : '') : '尚未发送'),
            h('span', null, '尝试'), h('span', null, j.attempts.length ? j.attempts.map((a) => '第' + a.n + '次：' + a.state + '（计费' + ({ charged: '已扣', free: '免费', unknown: '不确定', none: '没执行' }[a.billing] || a.billing) + '）' + (a.error ? ' ' + a.error : '')).join('；') : '还没开始')),
          ins.length ? h('div', { className: 'ab-flex', style: { marginTop: 8, flexWrap: 'wrap' } }, ins.map((r, i) => h('div', { key: i, className: 'ab-imgref' }, r.assetId ? h('img', { src: assetUrl(r.assetId), alt: '' }) : null, h('span', { className: 'ab-small ab-muted' }, (IMG_ROLES.find((x) => x.value === r.role) || {}).label || r.role)))) : null,
          outs.length > 1 ? h('div', { className: 'ab-flex', style: { marginTop: 8, flexWrap: 'wrap' } }, outs.map((id) => h('img', { key: id, className: 'ab-thumb big', src: assetUrl(id), alt: '' }))) : outs.length ? h('img', { className: 'ab-thumb big', style: { marginTop: 8 }, src: assetUrl(outs[0]), alt: '' }) : null) : null)
    }

    /** 蒙版：在底图上涂抹要改的地方。导出 PNG：涂过的地方完全透明，其余不透明（和 OpenAI 的约定一样）。 */
    function MaskPainter({ assetId, maskAssetId, onDone, onCancel, toast }) {
      const imgRef = useRef(null)
      const maskRef = useRef(null)
      const [size, setSize] = useState(36)
      const [ready, setReady] = useState(false)
      const drawing = useRef(false)
      useEffect(() => {
        let alive = true
        setReady(false)
        const img = new Image()
        img.onload = () => {
          if (!alive || !maskRef.current) return
          if (img.naturalWidth * img.naturalHeight > 50000000) { toast('图片尺寸太大，请缩小后再绘制蒙版', 'err'); return }
          imgRef.current = img
          const m = maskRef.current
          m.width = img.naturalWidth
          m.height = img.naturalHeight
          const g = m.getContext('2d')
          g.fillStyle = '#000'
          g.fillRect(0, 0, m.width, m.height)
          if (maskAssetId) {
            const previous = new Image()
            previous.onload = () => { if (!alive || !maskRef.current) return; g.clearRect(0, 0, m.width, m.height); g.drawImage(previous, 0, 0, m.width, m.height); setReady(true) }
            previous.onerror = () => { if (alive) toast('旧蒙版读取失败，请取消后重新绘制', 'err') }
            previous.src = assetUrl(maskAssetId)
          } else setReady(true)
        }
        img.onerror = () => { if (alive) toast('底图读取失败，请重新选择图片', 'err') }
        img.src = assetUrl(assetId)
        return () => { alive = false; drawing.current = false }
      }, [assetId, maskAssetId])
      const paint = (e) => {
        if (!ready || !drawing.current) return
        const m = maskRef.current
        const rect = m.getBoundingClientRect()
        const x = ((e.clientX - rect.left) / rect.width) * m.width
        const y = ((e.clientY - rect.top) / rect.height) * m.height
        const g = m.getContext('2d')
        g.globalCompositeOperation = 'destination-out'
        g.beginPath()
        g.arc(x, y, (size / rect.width) * m.width, 0, Math.PI * 2)
        g.fill()
        g.globalCompositeOperation = 'source-over'
      }
      const reset = () => { const m = maskRef.current; const g = m.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, m.width, m.height) }
      const done = async () => {
        const r = await post('/imagegen/upload', { data: maskRef.current.toDataURL('image/png') })
        if (!r.ok) return toast(r.message, 'err')
        onDone(r.assetId)
      }
      return h('div', { className: 'ab-mask' },
        h('div', { className: 'ab-small ab-muted' }, '在图上涂要改的地方（涂过的地方会变透明，露出底图）；没涂的地方保持原样。'),
        h('div', { className: 'ab-mask-stage' },
          h('img', { src: assetUrl(assetId), alt: '' }),
          h('canvas', { ref: maskRef, onPointerDown: (e) => { drawing.current = true; e.target.setPointerCapture(e.pointerId); paint(e) }, onPointerMove: paint, onPointerUp: () => { drawing.current = false }, onPointerCancel: () => { drawing.current = false } })),
        h('div', { className: 'ab-flex', style: { marginTop: 6 } },
          h('span', { className: 'ab-small' }, '笔刷'), h(Range, { min: 8, max: 120, value: size, onChange: setSize, fmt: (v) => v + 'px' }),
          h(Btn, { small: true, kind: 'ghost', onClick: reset }, '清空'),
          h('div', { className: 'ab-spacer' }),
          h(Btn, { small: true, kind: 'ghost', onClick: onCancel }, '取消'),
          h(Btn, { small: true, kind: 'primary', disabled: !ready, onClick: done }, '用这个蒙版')))
    }

    function Logs() {
      const [items, setItems] = useState(null)
      const [level, setLevel] = useState('info')
      const [area, setArea] = useState('')
      const [auto, setAuto] = useState(true)
      const load = useCallback(() => get('/logs?limit=400&level=' + level + '&area=' + area).then((r) => setItems(r.entries || [])), [level, area])
      useEffect(() => { load(); if (!auto) return; const t = setInterval(load, 3000); return () => clearInterval(t) }, [load, auto])
      return h(Card, { title: '日志', desc: '所有后台动作都在这里，令牌和密码已自动打码。完整日志文件在 %USERPROFILE%\\.dsh\\plugins-data\\aurabot\\logs\\。',
        right: h('div', { className: 'ab-flex' },
          h(Select, { value: level, onChange: setLevel, width: 110, options: [['debug', '全部'], ['info', '一般'], ['warn', '警告'], ['error', '错误']].map(([value, label]) => ({ value, label })) }),
          h(Select, { value: area, onChange: setArea, width: 130, options: [['', '所有模块'], ['core', '核心'], ['chat', '聊天'], ['onebot', 'QQ 网关'], ['snowluma', 'SnowLuma'], ['sticker', '表情'], ['voice', '语音'], ['imagegen', '生图'], ['speakup', '搭话']].map(([value, label]) => ({ value, label })) }),
          h('span', { className: 'ab-switch-row' }, h(Switch, { on: auto, onChange: setAuto }), h('span', { className: 'ab-muted ab-small' }, '自动刷新'))) },
        items === null ? h(Empty, { icon: '⏳', text: '加载中…' }) : items.length === 0 ? h(Empty, { text: '没有符合条件的日志' }) :
          h('div', { className: 'ab-logs' }, items.slice().reverse().map((e, i) => h(LogLine, { key: i, e }))))
    }

    // ---------------- 首次使用向导 ----------------
    const WIZ_STEPS = ['你们的 QQ 号', '准备 SnowLuma', '启动并同意协议', '接入机器人号', '完成']

    function Wizard({ st, draft, setDraft, save, toast, reload, onClose }) {
      const [step, setStep] = useState(() => { try { return Number(localStorage.getItem('aurabot.wiz') || 0) } catch (e) { return 0 } })
      const go = (i) => { setStep(i); try { localStorage.setItem('aurabot.wiz', String(i)) } catch (e) {} }
      const f = useField(draft, setDraft)
      const sl = st.snowluma
      const conn = st.onebot.state === 'connected'
      const login = st.onebot.login
      const [procs, setProcs] = useState(null)
      const [live, setLive] = useState('dry')
      const qqOk = /^\d{5,11}$/.test(draft.botQQ || '') && /^\d{5,11}$/.test(draft.ownerQQ || '') && draft.botQQ !== draft.ownerQQ
      const canNext = [qqOk, sl.installed, sl.running && sl.consented, conn && login && login.uin === st.config.botQQ, true][step]
      const next = async () => {
        if (step === 0 || step === 1) await save({ ...draft, enabled: true })
        if (step === 3) {} // 已连上
        go(Math.min(step + 1, WIZ_STEPS.length - 1))
        reload()
      }
      const body = [
        // 0. QQ 号
        h('div', null,
          h('p', { className: 'ab-desc' }, '大肥鱼需要一个自己的 QQ 号（机器人号），还要知道谁是她的主人。'),
          h(Row, { label: '机器人 QQ 号', hint: '强烈建议用小号：非官方 QQ 工具有被限制的风险' }, f.text('botQQ', { placeholder: '例如 123456789' })),
          h(Row, { label: '你的 QQ 号（主人）', hint: '群管、操作电脑这些只听主人的' }, f.text('ownerQQ', { placeholder: '你的大号' })),
          h(Row, { label: '她怎么称呼你' }, f.text('ownerName', { placeholder: '主人' })),
          draft.botQQ && draft.ownerQQ && draft.botQQ === draft.ownerQQ ? h('div', { className: 'ab-note err' }, '机器人号和主人号不能是同一个。') : null),
        // 1. SnowLuma
        h('div', null,
          h('p', { className: 'ab-desc' }, 'SnowLuma 是让机器人号上线的 QQ 网关。它的协议不允许别的程序自动下载安装，所以这一步要你自己来（只用做一次）。'),
          h('div', { className: 'ab-steps' },
            h('div', { className: 'ab-step' }, h('div', null, h('b', null, '下载'), h('div', { className: 'ab-muted ab-small' }, '下载 Windows 完整版，文件名类似 SnowLuma-v2.x.x-win-x64.zip（不带 lite）。'),
              h('div', { style: { marginTop: 6 } }, h(Btn, { small: true, onClick: () => window.open(sl.downloadPage, '_blank') }, '打开下载页 ↗')))),
            h('div', { className: cx('ab-step', sl.installed && 'done') }, h('div', null, h('b', null, '解压到纯英文目录'), h('div', { className: 'ab-muted ab-small' }, '推荐 C:\\Aurabot\\snowluma，解压后目录里能直接看到 index.mjs。'),
              h('div', { className: 'ab-flex', style: { marginTop: 6 } }, f.text('snowluma.dir', { size: 'wide', placeholder: 'C:\\Aurabot\\snowluma' }), h(Btn, { small: true, onClick: async () => { await save(draft); reload() } }, '检查')),
              h('div', { className: 'ab-small', style: { marginTop: 4, color: sl.installed ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, sl.installed ? '✓ 找到了 SnowLuma v' + sl.version : sl.reason))))),
        // 2. 启动 + 协议
        h('div', null,
          h('p', { className: 'ab-desc' }, '点启动后它在后台运行（不弹窗口），控制台密码由插件自动生成和保存，你不用记。'),
          h('div', { className: 'ab-flex', style: { marginBottom: 10 } },
            h(Btn, { kind: 'primary', small: true, disabled: sl.running, onClick: async () => { toast('正在启动…'); const r = await post('/snowluma/start'); toast(r.message); reload() } }, sl.running ? '✓ 已在运行' : '启动 SnowLuma'),
            h(SnowLumaAuth, { running: sl.running, toast, onChange: reload })),
          h(Agreement, { running: sl.running, toast, onChange: reload })),
        // 3. 接入
        h('div', null,
          h('p', { className: 'ab-desc' }, '在这台电脑上另开一个 QQ，登录机器人号 ' + (st.config.botQQ || '') + '（可以最小化）。你的大号 QQ 照常开着就行——插件只会接入机器人号，绝不碰别的号。'),
          h('div', { className: 'ab-flex' },
            h(Btn, { kind: 'primary', small: true, onClick: async () => { const r = await post('/snowluma/attach'); toast(r.message); setTimeout(reload, 1500) } }, '接入机器人号'),
            h(Btn, { small: true, onClick: async () => { const r = await get('/snowluma/processes'); setProcs(r.list || []); if (!r.ok) toast(r.message) } }, '看看有哪些 QQ 进程'),
            h(Btn, { small: true, onClick: async () => { const r = await get('/onebot/test'); toast(r.message) } }, '测试连接')),
          sl.lastAttach && sl.lastAttach.at ? h('div', { className: 'ab-small', style: { marginTop: 8, color: sl.lastAttach.ok ? 'var(--ab-ok)' : 'var(--ab-warn)' } }, sl.lastAttach.message) : null,
          conn && login ? h('div', { className: 'ab-note', style: { marginTop: 10 } }, login.uin === st.config.botQQ ? '✓ 连上了：' + login.nickname + '（' + login.uin + '）' : '⚠ 连上的是 ' + login.uin + '，不是机器人号') : h('div', { className: 'ab-muted ab-small', style: { marginTop: 10 } }, '接入后需要十几秒识别登录状态，稍等一下会自动刷新。'),
          procs ? h('table', { className: 'ab-table', style: { marginTop: 10 } }, h('tbody', null, procs.map((p) => h('tr', { key: p.pid }, h('td', null, p.pid), h('td', null, p.uin || '识别不出'), h('td', null, p.nickname || ''), h('td', null, p.isBot ? h('span', { className: 'ab-badge' }, '机器人号') : h('span', { className: 'ab-muted ab-small' }, '不会碰')))))) : null),
        // 4. 完成
        h('div', null,
          h('p', { className: 'ab-desc' }, '都准备好了！最后选一下她怎么上线：'),
          h(Choices, { value: live, onChange: setLive, options: [
            { value: 'dry', label: '先试运行', desc: '她会照常思考，但只写进日志、不真的发出去。看几条没问题再在右上角关掉试运行' },
            { value: 'live', label: '直接上线', desc: '马上开始真的回 QQ 消息' },
          ] }),
          h('div', { className: 'ab-flex', style: { marginTop: 12 } },
            h(Btn, { small: true, onClick: async () => { await save({ ...draft, enabled: true, dryRun: false }); const r = await post('/test-send'); toast(r.message); await save({ ...draft, enabled: true, dryRun: live === 'dry' }) } }, '给我发一条自测消息'))),
      ][step]
      return h('div', { className: 'ab-card', style: { padding: '20px 22px' } },
        h('div', { className: 'ab-flex', style: { marginBottom: 6 } }, h('h3', { style: { margin: 0, fontSize: 16 } }, '设置向导'), h('span', { className: 'ab-muted ab-small' }, '第 ' + (step + 1) + ' / ' + WIZ_STEPS.length + ' 步 · ' + WIZ_STEPS[step]), h('div', { className: 'ab-spacer' }),
          st.config.setupDone && onClose ? h(Btn, { small: true, kind: 'ghost', onClick: onClose }, '关闭向导') : null),
        h('div', { className: 'ab-wiz-bar' }, WIZ_STEPS.map((s, i) => h('button', { key: s, type: 'button', className: cx('seg', i < step && 'done', i === step && 'on'), onClick: () => i <= step && go(i), title: s }, h('span', null, s)))),
        h('div', { style: { minHeight: 220, marginTop: 14 } }, body),
        h('div', { className: 'ab-flex', style: { marginTop: 16, borderTop: '1px solid var(--ab-line)', paddingTop: 12 } },
          step > 0 ? h(Btn, { kind: 'ghost', onClick: () => go(step - 1) }, '上一步') : null,
          h('div', { className: 'ab-spacer' }),
          step < WIZ_STEPS.length - 1
            ? h(Btn, { kind: 'primary', disabled: !canNext, onClick: next }, '下一步')
            : h(Btn, { kind: 'primary', onClick: async () => {
              await save({ ...draft, enabled: true, dryRun: live === 'dry' })
              const r = await post('/setup/done'); toast(r.message, r.ok ? 'ok' : 'err')
              if (r.ok) { try { localStorage.removeItem('aurabot.wiz') } catch (e) {} reload(); onClose && onClose() }
            } }, '完成，让大肥鱼上线')))
    }

    function screenshotSource(source) {
      let info = source
      try { if (typeof info === 'string') info = JSON.parse(info) } catch { return '来源信息不可用' }
      if (!info || typeof info !== 'object') return '来源信息不可用'
      const clock = seconds => {
        if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return ''
        const n = Math.floor(Number(seconds)), hours = Math.floor(n / 3600), minutes = Math.floor(n % 3600 / 60), sec = n % 60
        return hours ? `${hours}:${String(minutes).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${minutes}:${String(sec).padStart(2,'0')}`
      }
      const method = { preview:'预览图抽帧', segment:'视频分段抽帧', stream:'视频流抽帧' }[info.method] || '截图'
      const at = clock(info.seconds), requested = clock(info.requestedSeconds)
      return [info.part ? 'P' + info.part + (info.partTitle ? ' ' + info.partTitle : '') : '', method,
        at ? '画面 ' + at : '', requested && requested !== at ? '请求 ' + requested : ''].filter(Boolean).join(' · ')
    }

    function NewFeatures({ draft, setDraft, toast }) {
      const f = useField(draft, setDraft)
      const policies = draft.crossChatHistory || []
      const editPolicy = (i, key, value) => { const rows = clone(policies); rows[i][key] = value; setDraft(setPath(draft, 'crossChatHistory', rows)) }
      const [target, setTarget] = useState('')
      const [shots, setShots] = useState(null)
      const [shotChat, setShotChat] = useState('private:' + String(draft.ownerQQ||''))
      const [shotPersona, setShotPersona] = useState(draft.persona?.current || '')
      const shotSeq = useRef(0)
      useEffect(() => () => { shotSeq.current++ }, [])
      return h('div', {className:'ab-grid'},
        h(Card,{title:'聊天与附件',desc:'收到的文件只在当前聊天中按需读取；历史默认不跨聊天。'},
          h(Row,{label:'接收文本附件'},f.sw('incomingFiles.enabled')),
          h(Row,{label:'@别人时忽略唤醒词'},f.sw('group.ignoreAtOthers')),
          h(Row,{label:'忽略发送者 QQ',hint:'每行一个 QQ 号；不会凭昵称或头衔猜测身份。'},f.list('ignoredSenderQQs',{numbers:true})),
          h(Row,{label:'新会话带入历史'},f.sw('conversation.seedHistory')),
          h(Row,{label:'宿主审批通知'},f.sw('approvalNotify'))),
        h(Card,{title:'跨聊天只读策略',desc:'仅主人私聊可访问明确授权的群，要求账号、人格和群成员身份匹配。'},
          policies.map((p,i)=>h('div',{key:i,className:'ab-card',style:{marginBottom:8}},
            h(Row,{label:'启用'},h(Switch,{on:!!p.enabled,onChange:v=>editPolicy(i,'enabled',v)})),
            ...[['account','机器人 QQ'],['persona','人格 ID'],['fromChatId','来源聊天'],['targetChatId','目标群']].map(([key,label])=>h(Row,{key,label},h('input',{className:'ab-input',value:p[key]||'',placeholder:key==='targetChatId'?'group:群号':key==='fromChatId'?'private:主人QQ':'',onChange:e=>editPolicy(i,key,e.target.value)}))),
            h(Btn,{kind:'ghost',small:true,onClick:()=>setDraft(setPath(draft,'crossChatHistory',policies.filter((_,j)=>j!==i)))},'移除'))),
          h(Btn,{small:true,onClick:()=>setDraft(setPath(draft,'crossChatHistory',[...policies,{enabled:false,account:String(draft.botQQ||''),persona:'',fromChatId:'private:'+String(draft.ownerQQ||''),targetChatId:''}]))},'＋ 添加策略')),
        h(Card,{title:'表情与语音'},
          h(Row,{label:'表情收集方式'},f.select('stickers.collectMode',[{value:'auto',label:'自动'},{value:'owner',label:'仅主人'},{value:'ask',label:'由模型选择'}])),
          h(Row,{label:'RVC 后处理'},f.sw('voice.rvc.enabled')),
          h(Row,{label:'RVC 音色'},f.text('voice.rvc.voice')),
          h(Row,{label:'RVC 音高'},f.num('voice.rvc.pitch',{min:-24,max:24})),
          h(Row,{label:'转换失败'},f.select('voice.rvc.fallback',[{value:'original',label:'使用原声'},{value:'error',label:'报告失败'}])),
          h(Row,{label:'转换超时（毫秒）'},f.num('voice.rvc.timeoutMs',{min:1000,max:300000}))),
        h(Card,{title:'主动搭话'},
          h(Row,{label:'目标聊天',hint:'每行 private:QQ 或 group:群号；留空只发给主人私聊。'},f.list('speakUp.targets')),
          h(Row,{label:'模式'},f.select('speakUp.mode',[{value:'ordinary',label:'普通'},{value:'purpose',label:'目的驱动'}])),
          h(Row,{label:'手动触发'},h('input',{className:'ab-input',value:target,placeholder:'留空为主人私聊',onChange:e=>setTarget(e.target.value)}),h(Btn,{small:true,onClick:async()=>{const r=await post('/speakup/fire',{target:target||undefined});toast(r.message || (r.ok?'已提交':'触发失败'),r.ok?'ok':'err')}},'尝试搭话'))),
        h(Card,{title:'B 站'},
          h(Row,{label:'启用弹幕'},f.sw('bili.danmakuEnabled')),
          h(Row,{label:'每日弹幕上限'},f.num('bili.maxDanmakuPerDay',{min:0,max:100})),
          h(Row,{label:'视频画面理解'},f.sw('bili.visionEnabled')),
          h(Row,{label:'抽帧数'},f.num('bili.visionFrames',{min:1,max:3})),
          h(Row,{label:'截图范围'},h('input',{className:'ab-input',value:shotChat,onChange:e=>{shotSeq.current++;setShotChat(e.target.value);setShots(null)},placeholder:'聊天 ID'}),h('input',{className:'ab-input',value:shotPersona,onChange:e=>{shotSeq.current++;setShotPersona(e.target.value);setShots(null)},placeholder:'人格 ID'}),h(Btn,{small:true,onClick:async()=>{const request=++shotSeq.current;const r=await get('/bili/screenshots?'+new URLSearchParams({chat:shotChat,persona:shotPersona}));if(request!==shotSeq.current)return;setShots(r);if(r.ok===false)toast(r.message,'err')}},'查看截图')),
          shots?.items ? h('div',{className:'ab-flex',style:{flexWrap:'wrap'}},...shots.items.map(item=>h('figure',{key:item.id},h('img',{src:API+'/bili/screenshot/image?'+new URLSearchParams({id:item.id,chat:shotChat,persona:shotPersona}),alt:'B站截图 '+item.bvid,style:{width:150}}),h('figcaption',null,item.bvid,h('div',{className:'ab-small ab-muted'},screenshotSource(item.source)),h('div',{className:'ab-small ab-muted'},item.id))))) : null))
    }

    // ---------------- 面板主体 ----------------
    const PANEL_GROUPS = { '常用':['overview','connect','persona','access','group','new-features'], '能力':['model','voice','stickers','imagegen','search','speakup','song','bili'], '记忆':['mood','memory','retrieval','media-memory','learning'], '管理':['tasks','local','modules','token-meter','diagnostics','logs'] }
    const panelGroupOf = id => Object.keys(PANEL_GROUPS).find(g => PANEL_GROUPS[g].includes(id)) || '扩展'
    function AurabotPage() {
      useStyle()
      const [st, setSt] = useState(null)
      const [err, setErr] = useState('')
      const [draft, setDraft] = useState(null)
      const [tab, setTab] = useState(() => { try { return localStorage.getItem('aurabot.tab') || 'overview' } catch (e) { return 'overview' } })
      const [toastMsg, setToastMsg] = useState(null)
      const [wizardOpen, setWizardOpen] = useState(false)
      const [navSearch, setNavSearch] = useState('')
      const [navGroup, setNavGroup] = useState(() => panelGroupOf(tab))
      const [personaVisited, setPersonaVisited] = useState(false)
      const navSearchRef = useRef(null)
      const toastTimer = useRef(null)
      const dirtyRef = useRef(false)
      const saveRef = useRef(null)
      // kind：ok / err / 不填 = 普通
      const toast = (m, kind) => {
        const text = String(m || '')
        const k = kind || (/失败|出错|没成功|不能|读不到|连不上/.test(text) ? 'err' : '')
        setToastMsg({ text, kind: k })
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToastMsg(null), 3200)
      }
      const reload = useCallback(async () => {
        const r = await get('/state')
        if (!r || r.ok === false) { setErr(r && r.message ? r.message : '读不到插件状态'); return }
        setErr('')
        setSt(r)
        if (!dirtyRef.current) setDraft(clone(r.config))
      }, [])
      useEffect(() => { reload(); const t = setInterval(reload, 5000); return () => clearInterval(t) }, [reload])
      const go = (id) => { if(id === 'persona') setPersonaVisited(true); setNavGroup(panelGroupOf(id)); setNavSearch(''); setTab(id); try { localStorage.setItem('aurabot.tab', id) } catch (e) {} }
      // 标签多、一屏放不下：滚轮横着滚，选中的标签自动滚进视野
      const tabsRef = useRef(null)
      useEffect(() => {
        const el = tabsRef.current
        if (!el) return
        const onWheel = (e) => { if (el.scrollWidth > el.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault() } }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      })
      useEffect(() => { tabsRef.current?.querySelector('.ab-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [tab])
      const dirty = useMemo(() => !!(st && draft) && JSON.stringify(draft) !== JSON.stringify(st.config), [st, draft])
      dirtyRef.current = dirty
      const setD = (d) => setDraft(d)
      const save = async (override) => {
        const body = override || draft
        for (const p of body.imageGen?.profiles || []) for (const [key, value] of Object.entries(p.extra || {})) {
          if (['workflow', 'bindings', 'submit', 'response', 'status', 'cancel', 'headers'].includes(key) && value != null && (typeof value !== 'object' || Array.isArray(value))) { toast(`「${p.name}」的 ${key} 不是合法 JSON 对象，请修正后再保存`, 'err'); return }
        }
        const r = await post('/save', body)
        if (r.ok === false) { toast(r.message || '保存失败', 'err'); return }
        dirtyRef.current = false
        setSt(r)
        setDraft(clone(r.config))
        toast(r.message || '保存好了', 'ok')
      }
      saveRef.current = save
      // 右上角的开关立刻生效；有没保存的改动时连同改动一起保存，不会把它们冲掉
      const quickToggle = async (path, v) => {
        await save(setPath(dirtyRef.current ? draft : clone(st.config), path, v))
      }
      // Ctrl/⌘ + S 保存
      useEffect(() => {
        const onKey = (e) => {
          if (e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); navSearchRef.current?.focus(); return }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && dirtyRef.current) {
            e.preventDefault()
            saveRef.current && saveRef.current()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      if (!st || !draft) {
        return h('div', { className: 'ab-root' }, h('div', { className: 'ab-wrap' }, err ? h('div', { className: 'ab-note err' }, '面板读不到插件：', err, '。如果刚装好插件，重启一次 DSH 试试。') : h(Empty, { icon: '🐋', text: '大肥鱼正在游过来…' })))
      }
      const cfg = st.config
      const conn = st.onebot.state === 'connected'
      const status = !cfg.enabled ? { cls: '', text: '休息中（总开关关着）' } : !conn ? { cls: 'err', text: 'QQ 没连上' } : cfg.dryRun ? { cls: 'warn', text: '在线 · 试运行' } : { cls: 'ok', text: '在线' }
      const persona = st.personas.find((p) => p.id === cfg.persona.current)
      const props = { st, draft, setDraft: setD, toast, reload, go, openWizard: () => setWizardOpen(true) }
      const showWizard = !cfg.setupDone || wizardOpen
      // 标签页：内置的按模块在不在跑决定显示；自己写的模块有设置或面板的各占一页
      const mods = st.modules || []
      const running = (id) => { const m = mods.find((x) => x.id === id); return Boolean(m && m.running) }
      const hasUi = (m) => m.running === 'user' && !m.builtin && ((m.settings || []).length || m.panel)
      // 写了 tab 的模块嵌进那个内置标签页；没写（或写的页不存在）的单独一页
      const intoTab = (m) => Boolean(m.tab && TABS.some((t) => t.id === m.tab))
      const extTabs = mods.filter((m) => hasUi(m) && !intoTab(m)).map((m) => ({ id: 'ext:' + m.id, label: m.name, ext: m.id }))
      const tabs = TABS.filter((t) => !TAB_MODS[t.id] || TAB_MODS[t.id].some(running))
      tabs.splice(tabs.findIndex((t) => t.id === 'logs'), 0, ...extTabs)
      const groups = PANEL_GROUPS, groupOf = panelGroupOf
      const visibleTabs = tabs.filter(t => navSearch.trim() ? t.label.toLowerCase().includes(navSearch.trim().toLowerCase()) : groupOf(t.id) === navGroup)
      const curTab = tabs.find((t) => t.id === tab) || tabs[0]
      const body = curTab.ext ? ExtPage : {
        overview: Overview, 'new-features': NewFeatures, connect: Connect, persona: Persona, access: Access, group: Group, model: Model, voice: Voice,
        stickers: Stickers, imagegen: ImageGen, search: SearchPanel, speakup: SpeakUp, mood: Mood, memory: ScopedMemory, retrieval: RetrievalPanel, 'media-memory': MediaMemory, learning: Learning, tasks: Tasks, song: Song, bili: Bili, local: LocalApi, modules: Modules, 'token-meter': TokenDashboard, diagnostics: Diagnostics, logs: Logs,
      }[curTab.id] || Overview
      // 哪些标签有没保存的改动
      const TAB_KEYS = { 'new-features': ['incomingFiles','group','ignoredSenderQQs','conversation','approvalNotify','crossChatHistory','stickers','voice','speakUp','bili'], connect: ['snowluma', 'botQQ'], access: ['ownerQQ', 'ownerName', 'ownerLevel', 'longTasks', 'profilePerms', 'allow'], group: ['group', 'merge', 'participation', 'conversation'], model: ['model', 'chatModels', 'roles', 'toolCallsPerTurn'], voice: ['voice'], stickers: ['stickers'], imagegen: ['imageGen'], search: ['search'], speakup: ['speakUp'], mood: ['mood'], memory: ['memory'], retrieval:['retrieval'], 'media-memory':['mediaMemory'], learning: ['learning'], tasks: ['tasks'], song: ['song'], bili: ['bili'], local: ['local'] }
      const tabDirty = (id) => {
        if (!dirty) return false
        if (id.startsWith('ext:')) { const k = id.slice(4); return JSON.stringify((draft.ext || {})[k]) !== JSON.stringify((cfg.ext || {})[k]) }
        return (TAB_KEYS[id] || []).some((k) => JSON.stringify(draft[k]) !== JSON.stringify(cfg[k]))
      }
      return h('div', { className: 'ab-root' },
        h('div', { className: 'ab-wrap' },
          h('div', { className: 'ab-hero' },
            h('button', { type: 'button', className: 'ab-avatar-btn', title: '点击换头像', onClick: () => pickAvatar(toast, reload) }, h('img', { className: 'ab-avatar', src: avatarSrc(st), alt: '头像' }), h('span', { className: 'ab-avatar-tip' }, '换头像')),
            h('div', { className: 'ab-hero-main' },
              h('h1', null, (st.onebot.login && st.onebot.login.nickname) || '大肥鱼'),
              h('div', { className: 'ab-sub' }, 'QQ ' + cfg.botQQ + ' · ' + (persona ? persona.name : '默认人格') + ' · ' + st.mood.label),
              h('div', { className: 'ab-pills' },
                h('span', { className: 'ab-pill' }, h('i', { className: cx('ab-dot', status.cls) }), status.text),
                h('span', { className: 'ab-pill' }, 'SnowLuma ' + (st.snowluma.installed ? (st.snowluma.running ? '运行中' : '没启动') : '未安装')),
                h('span', { className: 'ab-pill' }, 'Aurabot v' + st.version))),
            h('div', { className: 'ab-hero-side' },
              h('div', { className: 'ab-switch-row' }, h('span', null, '总开关'), h(Switch, { on: cfg.enabled, onChange: (v) => quickToggle('enabled', v) })),
              h('div', { className: 'ab-switch-row' }, h('span', { className: 'ab-muted' }, '试运行'), h(Switch, { on: cfg.dryRun, onChange: (v) => quickToggle('dryRun', v), title: '开着时只写日志，不真的发到 QQ' })))),
          showWizard ? h(Wizard, { st, draft, setDraft: setD, save, toast, reload, onClose: () => setWizardOpen(false) }) : null,
          showWizard ? null : h('div', {className:'ab-grid',style:{gap:6,marginTop:16}},
            h('div',{className:'ab-flex',style:{flexWrap:'wrap',gap:6}},
              ...[...Object.keys(groups),...(extTabs.length?['扩展']:[])].map(g=>h('button',{key:g,type:'button',className:cx('ab-tab',navGroup===g&&!navSearch&&'on'),onClick:()=>{setNavGroup(g);setNavSearch('')}},g)),
              h('input',{ref:navSearchRef,className:'ab-input',placeholder:'搜索页面（Alt+K）',value:navSearch,onChange:e=>setNavSearch(e.target.value),'aria-label':'搜索页面'})),
            h('div', { className: 'ab-tabs', role: 'tablist', ref: tabsRef, style:{margin:'0 0 10px'} }, visibleTabs.map((t) => {
              const flag = t.flag === 'group' ? cfg.allow.groups.length > 0 : t.flag ? getPath(cfg, t.flag) : null
              return h('button', { key: t.id, type: 'button', role: 'tab', 'aria-selected': curTab.id === t.id, className: cx('ab-tab', curTab.id === t.id && 'on'), onClick: () => go(t.id) }, t.label,
                tabDirty(t.id) ? h('i', { className: 'dirty', title: '有没保存的改动' }) : t.flag ? h('i', { className: cx('ab-dot', flag && 'ok'), title: flag ? '开着' : '关着' }) : null)
            }))),
          showWizard ? null : h('div',{style:{display:curTab.id==='persona'?'':'none'}},(personaVisited || curTab.id==='persona') ? h(TabBoundary,{onHome:()=>go('overview')},h(Persona,props)) : null),
          showWizard || curTab.id==='persona' ? null : h(TabBoundary, { key: curTab.id, onHome: () => go('overview') }, h(body, { ...props, mod: curTab.ext })),
          showWizard || curTab.ext ? null : mods.filter((m) => hasUi(m) && m.tab === curTab.id).map((m) => h('div', { key: 'embed-' + m.id, style: { marginTop: 14 } }, h(ExtPage, { ...props, mod: m.id, embedded: true }))),
          dirty && !showWizard ? h('div', { className: 'ab-savebar' }, h('span', { className: 'msg' }, '有改动还没保存'),
            h('span', { className: 'ab-muted ab-small' }, h('span', { className: 'ab-kbd' }, 'Ctrl'), ' + ', h('span', { className: 'ab-kbd' }, 'S')),
            h(Btn, { kind: 'ghost', onClick: () => setDraft(clone(st.config)) }, '撤销'),
            h(Btn, { kind: 'primary', onClick: () => save() }, '保存设置')) : null,
        ),
        toastMsg ? h('div', { className: cx('ab-toast', toastMsg.kind), role: 'status' }, toastMsg.text) : null,
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 写法同 DSH 自带的「自动化任务」（order 10）和「插件」（order 0）：排在它们后面
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, AurabotPage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'Aurabot' }, WhaleIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.AurabotPage = AurabotPage
    exports.WhaleIcon = WhaleIcon
    return module.exports
  },
})
