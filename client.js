// dsh-backup-all · 浏览器端 UI（纯 JS，无构建；React 由浏览器模块表提供）
//
// 组成：
//   settings.section —— 设置窗口侧边的「Backup ALL」页（页头 / 快照列表 / 已归档 / 高级设置 /
//                       创建两步流程 / 恢复窗口 / 运行观察窗口 /
//                       引入快照弹窗 · 卡片导出 · OS 类型徽章（v1.1.0，docs/PLATFORM-STRATEGIES.md §4/§5））
//   shell.overlay    —— 后台运行时的贴边圆形进度悬浮球 + 快照进程窗口（终态后停留 3 秒）
//
// 数据全部来自 Host 的 /dsh-backup-all/* HTTP 接口（docs/API-CONTRACT.md）。
// 轮询集中在模块级单例 STORE：/state 600ms；有 run 时 /log 450ms（终态且读满即停）。
// 设置页与悬浮球通过 subscribe + 引用计数共享同一 STORE，绝不各自轮询。
//
// 硬约束自查：无 import / JSX / TS；只 require('react')；不向全局 body 挂任何东西、不改别人的 DOM
// （例外：导出下载的临时 <a download> 挂 body，点击后 1500ms 内移除并 revoke objectURL）；
// 所有 fetch 路径以 /dsh-backup-all 开头；所有字段读取可选链/兜底；组件不抛错。
// 颜色只用 var(--dsw-alias-*)；例外是 UI-SPEC 允许写死的状态色
// （版本徽章绿、pre-restore 徽章橙、OS 徽章蓝/橙/灰、完成淡绿、中断/失败红系、遮罩黑）。

window.__ModuleLoader__.load({
  id: 'dsh-backup-all',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    // ─────────────────────────────────────────────────────────────
    // 样式：一个 <style> 元素承载全部类，类前缀 dswba-
    // 说明：主按钮文字用 --dsw-alias-label-primary-foreground 而不是写死 #fff——
    //       brand-primary 在亮色主题近黑、暗色主题近白，foreground token 会随主题翻转，
    //       两种主题下都保证可读（这是 UI-SPEC「白字」在真实 token 体系下的正确落法）。
    // ─────────────────────────────────────────────────────────────
    const CSS = `
.dswba-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:18px 24px 24px;color:var(--dsw-alias-label-primary);overflow:auto;font-size:13px}
.dswba-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dswba-title{display:flex;align-items:center;gap:8px;font-size:20px;font-weight:650;letter-spacing:.2px;min-width:0}
.dswba-ver{border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;background:rgba(46,160,67,.16);color:#2ea043;line-height:18px;flex:none}
.dswba-head-right{text-align:right;font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.5;flex:none}
.dswba-head-right b{color:var(--dsw-alias-label-primary);font-weight:600}
.dswba-head-count{font-size:11px;opacity:.8;margin-top:1px}
.dswba-nav{display:flex;gap:2px;margin-top:12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.dswba-nav-item{appearance:none;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;padding:8px 14px;margin-bottom:-1px;font-size:13.5px;color:var(--dsw-alias-label-secondary);font-family:inherit}
.dswba-nav-item:hover{color:var(--dsw-alias-label-primary)}
.dswba-nav-item.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary)}

.dswba-toolbar{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}
.dswba-search{display:flex;align-items:center;gap:6px;flex:1;min-width:180px;max-width:320px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);box-sizing:border-box}
.dswba-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dswba-search input{flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dswba-search input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
/* 窄屏（≤480px）适配：Host 在 ≤1024px 对设置弹窗内容注入 !important 覆盖
   （* → min-width:0/max-width:100%；[class*="row"] → width:100%/flex-wrap:wrap），
   .dswba-search 的 min-width:180px 会被压掉、挤成 ~40px。这里让搜索框独占一行、
   按钮排第二行；行内 input 改为可收缩、单位下拉钉 110px，保证值区 >60px。 */
@media (max-width: 480px) {
  .dswba-toolbar{flex-wrap:wrap}
  .dswba-toolbar .dswba-search{flex:1 1 100%;max-width:none;order:-1}
  .dswba-toolbar .dswba-spacer{display:none}
  .dswba-toolbar .dswba-btn{flex:0 0 auto}
  .dswba-row .dswba-input{width:auto;flex:1 1 120px}
  .dswba-row .dswba-unit{width:110px;flex:0 0 110px}
}
.dswba-spacer{flex:1}

.dswba-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,border-color .15s,opacity .15s;box-sizing:border-box}
.dswba-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dswba-btn:disabled{opacity:.5;cursor:not-allowed}
.dswba-btn.dswba-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:550}
.dswba-btn.dswba-primary:hover:not(:disabled){opacity:.86;background:var(--dsw-alias-brand-primary)}
.dswba-btn.dswba-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.dswba-btn.dswba-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dswba-btn.dswba-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dswba-btn.dswba-danger:hover:not(:disabled){background:rgba(218,54,51,.1)}
.dswba-btn.dswba-danger-solid{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:#fff;font-weight:550}
.dswba-btn.dswba-danger-solid:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-state-error-primary)}
.dswba-btn.dswba-sm{height:26px;padding:0 8px;font-size:12px;border-radius:7px}
.dswba-link{background:none;border:none;color:var(--dsw-alias-link);font-size:12px;cursor:pointer;text-decoration:underline;padding:0;font-family:inherit}

.dswba-statusbar{display:flex;align-items:center;gap:8px;margin-top:12px;padding:8px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;min-width:0}
.dswba-statusbar:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dswba-statusbar-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dswba-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none;animation:dswba-pulse 1.2s ease-in-out infinite}

.dswba-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:14px}
.dswba-card{position:relative;display:flex;flex-direction:column;min-height:150px;padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box;transition:border-color .15s}
.dswba-card:hover{border-color:var(--dsw-alias-border-l2)}
.dswba-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.dswba-card-name{font-size:15px;font-weight:650;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dswba-card-time{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}
.dswba-card-desc{margin-top:10px;flex:1;font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary);text-align:left;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.dswba-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px}
.dswba-card-size{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none}
.dswba-card-actions{display:flex;gap:2px;flex-wrap:wrap;justify-content:flex-end}
.dswba-chip{display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:1px 8px;font-size:10.5px;font-weight:600;background:rgba(210,153,34,.16);color:#d29922;white-space:nowrap;flex:none}
.dswba-card-title{display:flex;align-items:center;gap:6px;min-width:0}
.dswba-card-title .dswba-card-name{min-width:0}
.dswba-os-badge{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:4px;font-size:11px;line-height:1;color:#fff;font-weight:600;letter-spacing:.2px;white-space:nowrap}
.dswba-os-windows{background:#2563eb}
.dswba-os-linux{background:#c2410c}
.dswba-os-unknown{background:#6b7280}
.dswba-import-file{display:flex;align-items:center;gap:8px;min-height:34px;padding:0 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary);box-sizing:border-box}
.dswba-import-file.hasFile{color:var(--dsw-alias-label-primary);border-style:solid}
.dswba-import-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dswba-import-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);opacity:.85;line-height:1.5}
.dswba-import-error{font-size:12px;color:var(--dsw-alias-state-error-primary);word-break:break-word}

.dswba-promote{width:100%;margin-top:12px}

.dswba-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:56px 12px;color:var(--dsw-alias-label-secondary);text-align:center}
.dswba-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dswba-empty-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}

.dswba-adv{display:flex;flex-direction:column;gap:12px;margin-top:16px;max-width:860px}
.dswba-ai-btn{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:56px;padding:10px 16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left;box-sizing:border-box;transition:border-color .15s,background .15s}
.dswba-ai-btn:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dswba-ai-btn-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dswba-ai-btn-title{font-size:14px;font-weight:650}
.dswba-ai-btn-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dswba-ai-status{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.dswba-ai-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.dswba-led{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dswba-led.ok{background:var(--dsw-alias-state-success-primary)}
.dswba-led.bad{background:var(--dsw-alias-state-error-primary)}
.dswba-chevron{transition:transform .15s;color:var(--dsw-alias-label-secondary);flex:none}
.dswba-chevron.open{transform:rotate(180deg)}

.dswba-form{margin-top:10px;padding:16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;box-sizing:border-box}
.dswba-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dswba-field.full{grid-column:1 / -1}
.dswba-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}
.dswba-input,.dswba-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:7px 10px;outline:none;transition:border-color .15s}
.dswba-input:focus,.dswba-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dswba-input::placeholder,.dswba-textarea::placeholder{color:var(--dsw-alias-label-secondary);opacity:.6}
.dswba-textarea{resize:vertical;min-height:72px;line-height:1.5}
.dswba-row{display:flex;gap:8px;align-items:center}
.dswba-unit{width:70px;flex:none}
.dswba-eye{flex:none;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dswba-eye:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}

/* SelectBox 自建锚定下拉（替代原生 <select>）：
   Android WebView 对原生 select 弹系统 picker——不继承主题样式、也不锚定在控件下方，
   而是从屏幕外「飞进来」。这里菜单是触发器外层 position:relative 容器里的 absolute 子节点，
   top:calc(100% + 4px) 紧贴触发器底边向下展开；无 position:fixed、无 portal、无视口定位、
   无滑入动画（唯一动效是触发器右侧 chevron 随展开旋转 .15s）。
   触发器尺寸/配色与 .dswba-input 对齐：34px 高、border l1、radius 8、bg-base、13px 字。
   ⚠ 箭头类名必须是 dswba-dd-chev、不能叫 dswba-dd-arrow：Host ≤1024px 对设置弹窗内容注入
   「[class*=row]{width:100%!important;flex-wrap:wrap!important}」——"arrow" 含子串 "row"，
   旧类名会被整条 !important 命中，箭头撑满整行（238px）、值区 flex:1 1 0% 被挤成 0。
   chev 同时钉死 flex:0 0 14px + svg 14px/max-width:none，双保险免疫 Host 的 * 覆盖。 */
.dswba-dd{position:relative;display:flex;min-width:0}
.dswba-dd-btn{display:flex;align-items:center;gap:6px;width:100%;height:34px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.4;text-align:left;cursor:pointer;outline:none;transition:border-color .15s}
.dswba-dd-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dswba-dd-btn:focus,.dswba-dd.open .dswba-dd-btn{border-color:var(--dsw-alias-brand-primary)}
.dswba-dd-btn:disabled{opacity:.5;cursor:not-allowed}
.dswba-dd-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dswba-dd-chev{display:flex;flex:0 0 14px;width:14px;height:14px;overflow:hidden;color:var(--dsw-alias-label-secondary);transition:transform .15s}
.dswba-dd.open .dswba-dd-chev{transform:rotate(180deg)}
.dswba-dd-chev svg{width:14px;height:14px;max-width:none;max-height:none;flex:none}
.dswba-dd-menu{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:60;max-height:240px;overflow:auto;padding:4px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 28px rgba(0,0,0,.22)}
.dswba-dd-opt{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary);cursor:pointer}
.dswba-dd-opt.hi{background:var(--dsw-alias-bg-layer-2)}
.dswba-dd-opt.sel{color:var(--dsw-alias-brand-primary);font-weight:550}
.dswba-dd-opt-label{flex:1;min-width:0;word-break:break-word}
.dswba-dd-check{display:flex;flex:none;color:var(--dsw-alias-brand-primary)}

.dswba-form-foot{grid-column:1 / -1;display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:2px;flex-wrap:wrap}
.dswba-form-hint{font-size:12px;margin-right:auto;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dswba-ok{color:var(--dsw-alias-state-success-primary)}
.dswba-err{color:var(--dsw-alias-state-error-primary)}

/* 快照策略卡片（高级设置）：与 .dswba-form 同一套字段式设计——
   每行 label 小字在上（.dswba-label，12px secondary）→ 控件 → 动态提示（11.5px）；
   行间距 4px（同 .dswba-field），卡片 padding 16px / 圆角 10px / layer-1 底 / l1 边框；
   标题+副标题在最上，保存按钮在右下角。 */
.dswba-snap{padding:16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box;display:flex;flex-direction:column;gap:14px}
.dswba-snap-head{display:flex;flex-direction:column;gap:2px}
.dswba-snap-title{font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary)}
.dswba-snap-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dswba-snap-row{display:flex;flex-direction:column;gap:4px;min-width:0}
.dswba-snap-dd{max-width:420px}
.dswba-snap-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dswba-snap-hint.warn{color:var(--dsw-alias-state-error-primary)}
.dswba-snap-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap}
/* 自建开关（role=switch）：关=灰轨道，开=brand 轨道 + 旋钮右移 */
.dswba-switch{position:relative;flex:none;width:40px;height:22px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background .15s,border-color .15s}
.dswba-switch:disabled{opacity:.5;cursor:not-allowed}
.dswba-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s,background .15s}
.dswba-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dswba-switch[aria-checked="true"] .dswba-switch-knob{transform:translateX(18px);background:var(--dsw-alias-label-primary-foreground)}

.dswba-clearbtn{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;width:100%;height:52px;padding:0 16px;border-radius:10px;border:1px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary);cursor:pointer;font:inherit;text-align:left;box-sizing:border-box;transition:background .15s}
.dswba-clearbtn:hover{background:rgba(218,54,51,.1)}
.dswba-clearbtn-t{font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px}
.dswba-clearbtn-s{font-size:11.5px;opacity:.8}

.dswba-modal-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45);padding:24px;box-sizing:border-box}
.dswba-modal{width:440px;max-width:100%;max-height:calc(100vh - 48px);overflow:auto;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 60px rgba(0,0,0,.35);padding:20px;box-sizing:border-box;animation:dswba-pop .16s ease}
.dswba-modal.dswba-wide{width:760px}
@keyframes dswba-pop{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}
.dswba-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.dswba-modal-title{font-size:15.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dswba-x{border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;padding:4px;display:inline-flex;flex:none}
.dswba-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dswba-dlg-note{font-size:12px;color:var(--dsw-alias-label-secondary);margin:-6px 0 12px;line-height:1.55}
.dswba-dlg-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:16px;flex-wrap:wrap}
.dswba-confirm-body{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.dswba-warn-row{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-state-warn-primary);margin-top:10px;flex-wrap:wrap}
.dswba-errmsg{margin-top:8px;font-size:12.5px;color:var(--dsw-alias-state-error-primary);word-break:break-word}

.dswba-swnote{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0 0 12px;line-height:1.5}
.dswba-run-hint{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none}
.dswba-out{height:280px;overflow:auto;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;box-sizing:border-box}
.dswba-line{display:block;min-height:1.6em}
.dswba-line.assistant{color:var(--dsw-alias-label-primary)}
.dswba-line.tool{color:var(--dsw-alias-label-secondary)}
.dswba-line.system{color:var(--dsw-alias-brand-primary);font-weight:550}
.dswba-line.error{color:var(--dsw-alias-state-error-primary)}
.dswba-line.idle{color:var(--dsw-alias-label-secondary);opacity:.7}
.dswba-run-error{margin-top:10px;font-size:12px;color:var(--dsw-alias-state-error-primary);text-align:center;word-break:break-word;line-height:1.5}
.dswba-run-tip{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center}
.dswba-run-summary{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center;line-height:1.55;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dswba-run-close{display:flex;justify-content:center;margin-top:12px}

/* 多功能进度按钮：idle(蓝) / starting / running(进度填充+流光, hover 淡红「中断」)
   / interrupting(进度回退) / interrupted(实红) / done(淡绿) / failed(淡红) */
.dswba-runbtn{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:44px;margin-top:12px;border:1px solid transparent;border-radius:10px;overflow:hidden;cursor:pointer;font:inherit;font-size:14px;font-weight:600;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground);transition:background .2s,color .2s,border-color .2s,opacity .2s;user-select:none;padding:0}
.dswba-runbtn:disabled{cursor:default}
.dswba-runbtn.dswba-st-idle:hover:not(:disabled){opacity:.87}
.dswba-runbtn.dswba-st-starting{opacity:.82}
.dswba-runbtn.dswba-st-running:hover:not(.dswba-noabort){background:rgba(218,54,51,.82);color:#fff}
.dswba-runbtn.dswba-st-interrupting{background:rgba(218,54,51,.82);color:#fff}
.dswba-runbtn.dswba-st-interrupted{background:var(--dsw-alias-state-error-primary);color:#fff}
.dswba-runbtn.dswba-st-done{background:rgba(46,160,67,.18);color:#2ea043;border-color:rgba(46,160,67,.55)}
.dswba-runbtn.dswba-st-failed{background:rgba(218,54,51,.14);color:var(--dsw-alias-state-error-primary);border-color:rgba(218,54,51,.4)}
.dswba-run-label,.dswba-run-hover{position:relative;z-index:2;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:92%}
.dswba-run-hover{display:none}
.dswba-runbtn.dswba-st-running:hover:not(.dswba-noabort) .dswba-run-label{display:none}
.dswba-runbtn.dswba-st-running:hover:not(.dswba-noabort) .dswba-run-hover{display:flex}
.dswba-fill{position:absolute;left:0;top:0;bottom:0;background:currentColor;opacity:.18;transition:width .25s ease;pointer-events:none;z-index:1}
.dswba-sheen-anchor{position:absolute;top:0;bottom:0;width:0;transition:left .25s ease;pointer-events:none;z-index:1}
.dswba-sheen{position:absolute;left:-60px;top:-12px;bottom:-12px;width:120px;background:linear-gradient(90deg,transparent,currentColor,transparent);opacity:.3;transform:skewX(-18deg);animation:dswba-sheen 1.4s linear infinite}
@keyframes dswba-sheen{0%{opacity:0;transform:skewX(-18deg) translateX(-44px)}25%{opacity:.3}75%{opacity:.3}100%{opacity:0;transform:skewX(-18deg) translateX(44px)}}
.dswba-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(127,127,127,.35);border-top-color:currentColor;animation:dswba-spin .9s linear infinite;flex:none;box-sizing:border-box}

/* 悬浮球 + 进程窗口（shell.overlay 层本身点击穿透，根容器 none、球/面板 auto） */
.dswba-float-root{pointer-events:none}
.dswba-ball{pointer-events:auto;position:fixed;right:10px;top:50%;transform:translateY(-50%);width:48px;height:48px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:0 4px 16px rgba(0,0,0,.28);cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;z-index:1500;transition:transform .15s ease,box-shadow .15s ease;animation:dswba-ball-in .2s ease}
.dswba-ball:hover{transform:translateY(-50%) scale(1.07);box-shadow:0 6px 20px rgba(0,0,0,.34)}
@keyframes dswba-ball-in{from{opacity:0;transform:translateY(-50%) scale(.8)}to{opacity:1;transform:translateY(-50%) scale(1)}}
.dswba-ball svg{position:absolute;inset:2px}
.dswba-ball-txt{position:relative;font-size:10px;font-weight:700;color:var(--dsw-alias-label-primary)}
.dswba-ball-ring{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:3}
.dswba-ball-fill{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:3;stroke-linecap:round;transition:stroke-dashoffset .3s ease,stroke .3s ease}
.dswba-ball-fill.done{stroke:var(--dsw-alias-state-success-primary)}
.dswba-ball-fill.bad{stroke:var(--dsw-alias-state-error-primary)}
.dswba-panel{pointer-events:auto;position:fixed;right:70px;top:50%;transform:translateY(-50%);width:520px;max-width:calc(100vw - 96px);height:420px;max-height:calc(100vh - 48px);border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 20px 60px rgba(0,0,0,.4);padding:16px;z-index:1501;box-sizing:border-box;display:flex;flex-direction:column;animation:dswba-pop .16s ease}
.dswba-panel .dswba-out{height:auto;flex:1;min-height:0}
.dswba-panel-body{display:flex;flex-direction:column;flex:1;min-height:0}

.dswba-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:1400;padding:9px 16px;border-radius:9px;background:var(--dsw-alias-toast-bg,var(--dsw-alias-bg-overlay));color:var(--dsw-alias-toast-label,var(--dsw-alias-label-primary));border:1px solid var(--dsw-alias-border-l1);box-shadow:0 8px 28px rgba(0,0,0,.3);font-size:13px;pointer-events:none;max-width:80vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:dswba-toast-in .18s ease}
@keyframes dswba-toast-in{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes dswba-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes dswba-spin{to{transform:rotate(360deg)}}
@media (max-width:640px){.dswba-form{grid-template-columns:1fr}}
`;

    // ─────────────────────────────────────────────────────────────
    // 小工具（全部纯函数）
    // ─────────────────────────────────────────────────────────────

    function pad2(n) {
      return String(n).padStart(2, '0');
    }

    // 1024 进制自适应 B/KB/MB/GB；1 位小数、去尾 .0（与 Host formatBytes 同规则）
    function formatSize(bytes) {
      const n = Number(bytes);
      if (!isFinite(n) || n <= 0) return '0 B';
      if (n < 1024) return Math.round(n) + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let v = n / 1024;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
      }
      return (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + ' ' + units[i];
    }

    // ISO → 本地 YYYY-MM-DD HH:mm:ss（卡片时间）
    function formatTime(iso) {
      if (!iso) return '';
      const d = new Date(String(iso));
      if (isNaN(d.getTime())) return String(iso);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }

    // 默认快照名：本地时间 YYYY-MM-DD HH-mm-ss（时-分-秒连字符，可作文件名）
    function defaultSnapshotName() {
      const d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
    }

    // token 数 → K/M 表单值（UI-SPEC 1.8 回填规则：能被 1000 整除优先 K，否则整除 1000000 用 M；
    // 都不整除（如 65536）按 K 保留小数，保存时 Host 换算回 token 无损）
    function tokenToForm(tokens, defValue, defUnit) {
      const n = Number(tokens);
      if (!isFinite(n) || n <= 0) return { value: String(defValue), unit: defUnit };
      if (n % 1000 === 0) return { value: String(n / 1000), unit: 'K' };
      if (n % 1000000 === 0) return { value: String(n / 1000000), unit: 'M' };
      return { value: String(Math.round(n) / 1000), unit: 'K' };
    }

    function truncate(s, n) {
      const t = String(s == null ? '' : s);
      return t.length > n ? t.slice(0, n) + '…' : t;
    }

    // 恢复前快照固定排最前（Host 已保证顺序，客户端按 kind 稳定排序兜底）
    function sortPreFirst(list) {
      return (Array.isArray(list) ? list : []).slice().sort(function (a, b) {
        const pa = a && a.kind === 'pre-restore' ? 1 : 0;
        const pb = b && b.kind === 'pre-restore' ? 1 : 0;
        return pb - pa;
      });
    }

    // 决定运行窗口该显示哪个 run：
    //  - myRunId 命中 → 显示它（含终态：本窗口启动/关注的 run）
    //  - 无 myRunId → 只显示「正在运行且 kind 匹配」的 run，
    //    避免新开的创建/恢复窗口把 Host 保留的上一次终态 run 误显示出来
    function pickRun(run, myRunId, wantKind) {
      if (!run) return null;
      if (myRunId) return run.id === myRunId ? run : null;
      if (run.status === 'running' && (!wantKind || run.kind === wantKind)) return run;
      return null;
    }

    // ─────────────────────────────────────────────────────────────
    // HTTP 封装（全部以 /dsh-backup-all 开头；永不 throw，失败返回 {ok:false,error}）
    // ─────────────────────────────────────────────────────────────

    async function fetchJSON(path) {
      try {
        const res = await fetch(path, { cache: 'no-store' });
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch (e) {
          return { ok: false, error: '接口返回非 JSON（HTTP ' + res.status + '）' };
        }
      } catch (error) {
        return { ok: false, error: '网络错误，无法连接 Backup ALL 服务' };
      }
    }

    async function postJSON(path, body) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        });
        const text = await res.text();
        try {
          const j = JSON.parse(text);
          if (j && typeof j === 'object' && !j.ok && !j.error) j.error = 'HTTP ' + res.status;
          return j;
        } catch (e) {
          return { ok: false, error: '接口返回非 JSON（HTTP ' + res.status + '）' };
        }
      } catch (error) {
        return { ok: false, error: '网络错误，无法连接 Backup ALL 服务' };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 模块级单例 STORE：/state 600ms；有 run 时 /log 450ms；引用计数启停
    // ─────────────────────────────────────────────────────────────

    const STORE = {
      state: null,      // 最近一次 /state 成功响应
      lastError: '',    // 最近一次失败原因（成功后清空）
      log: [],          // 当前 run 的输出行（客户端同样截断到 500）
      cursor: 0,        // /log?since= 游标
      logRunId: '',     // log 归属的 run id
      listeners: new Set(),
      refs: 0,
      timer: null,
      logTimer: null,
      busyState: false,
      busyLog: false,

      subscribe(fn) {
        STORE.listeners.add(fn);
        return function () { STORE.listeners.delete(fn); };
      },
      notify() {
        for (const fn of Array.from(STORE.listeners)) {
          try { fn(); } catch (e) { /* 单个订阅者出错不能影响其它订阅者 */ }
        }
      },
      start() {
        STORE.refs++;
        if (STORE.timer) return;
        STORE.pollState();
        STORE.timer = setInterval(function () { STORE.pollState(); }, 600);
        STORE.logTimer = setInterval(function () { STORE.pollLog(); }, 450);
      },
      stop() {
        STORE.refs = Math.max(0, STORE.refs - 1);
        if (STORE.refs > 0) return;
        if (STORE.timer) clearInterval(STORE.timer);
        if (STORE.logTimer) clearInterval(STORE.logTimer);
        STORE.timer = null;
        STORE.logTimer = null;
      },
      // 写操作成功后立即手动刷新一次（契约要求）
      refresh() {
        STORE.pollState();
        STORE.pollLog();
      },
      async pollState() {
        if (STORE.busyState) return;
        STORE.busyState = true;
        let j = null;
        try {
          j = await fetchJSON('/dsh-backup-all/state');
        } finally {
          STORE.busyState = false;
        }
        if (j && j.ok) {
          const prevRunId = STORE.state && STORE.state.run ? STORE.state.run.id : '';
          STORE.state = j;
          STORE.lastError = '';
          const nextRunId = j.run && j.run.id ? j.run.id : '';
          if (nextRunId !== prevRunId) {
            // run 切换：清空旧输出，从头拉新 run
            STORE.log = [];
            STORE.cursor = 0;
            STORE.logRunId = nextRunId;
          }
          STORE.notify();
          STORE.pollLog();
        } else {
          STORE.lastError = String((j && j.error) || '无法连接 Backup ALL 服务');
          STORE.notify();
        }
      },
      async pollLog() {
        const run = STORE.state && STORE.state.run;
        if (!run || !run.id) return;
        if (STORE.logRunId !== run.id) {
          STORE.logRunId = run.id;
          STORE.cursor = 0;
          STORE.log = [];
        }
        // 终态且已读满 → 停止拉取（避免任务结束后仍每 450ms 打一次接口）
        const oc = typeof run.outputCursor === 'number' ? run.outputCursor : -1;
        if (run.status !== 'running' && oc >= 0 && STORE.cursor >= oc) return;
        if (STORE.busyLog) return;
        STORE.busyLog = true;
        let j = null;
        try {
          j = await fetchJSON('/dsh-backup-all/log?since=' + encodeURIComponent(String(STORE.cursor)) +
            '&runId=' + encodeURIComponent(String(run.id)));
        } finally {
          STORE.busyLog = false;
        }
        if (!j || !j.ok) return;
        // Host 端 run 已切换（返回了别的 runId 的全量）：重置后下一拍再拉
        if (j.runId && STORE.state && STORE.state.run && j.runId !== STORE.state.run.id) {
          STORE.log = [];
          STORE.cursor = 0;
          STORE.logRunId = '';
          return;
        }
        let changed = false;
        if (Array.isArray(j.lines) && j.lines.length) {
          STORE.log = STORE.log.concat(j.lines).slice(-500);
          changed = true;
        }
        if (typeof j.cursor === 'number' && j.cursor > STORE.cursor) {
          STORE.cursor = j.cursor;
          changed = true; // Host 丢弃过旧行时游标也会前进
        }
        if (changed) STORE.notify();
      },
    };

    // 组件订阅 hook：tick 驱动重渲染 + 引用计数启停轮询
    function useStore() {
      const [, setTick] = useState(0);
      useEffect(function () {
        let alive = true;
        const unsub = STORE.subscribe(function () {
          if (alive) setTick(function (x) { return (x + 1) % 1000000; });
        });
        STORE.start();
        return function () {
          alive = false;
          unsub();
          STORE.stop();
        };
      }, []);
      return { state: STORE.state, log: STORE.log, error: STORE.lastError };
    }

    // ─────────────────────────────────────────────────────────────
    // Esc 关闭栈：多层弹窗（运行窗口 → 关闭确认）时只关最上面一层
    // ─────────────────────────────────────────────────────────────

    const ESC_STACK = [];
    let escBound = false;
    function bindEsc() {
      if (escBound) return;
      escBound = true;
      try {
        // 捕获阶段监听：比 DSH 设置面板挂在 document 上的冒泡监听更早拿到 Esc，
        // 从而做到「只关本插件最上层」，不会把设置弹窗一起关掉。
        window.addEventListener('keydown', function (e) {
          if (e.key !== 'Escape') return;
          const top = ESC_STACK[ESC_STACK.length - 1];
          if (top && typeof top.fn === 'function') {
            e.preventDefault();
            e.stopPropagation();
            if (typeof e.stopImmediatePropagation === 'function') {
              try { e.stopImmediatePropagation(); } catch (err) { /* 忽略 */ }
            }
            try { top.fn(); } catch (err) { /* 回调出错不外溢 */ }
          }
        }, true);
      } catch (e) { /* 极端环境下放弃 Esc 支持 */ }
    }
    // 用「栈内条目原地更新 fn」而不是重渲染时 pop+push：
    // 否则父弹窗（每次渲染换新函数标识）会被重新压到嵌套确认框之上，Esc 关错层。
    function useEscSlot(fn) {
      const entryRef = useRef(null);
      useEffect(function () {
        if (!fn) {
          if (entryRef.current) {
            const i = ESC_STACK.indexOf(entryRef.current);
            if (i >= 0) ESC_STACK.splice(i, 1);
            entryRef.current = null;
          }
          return;
        }
        if (!entryRef.current) {
          bindEsc();
          entryRef.current = { fn: fn };
          ESC_STACK.push(entryRef.current);
        } else {
          entryRef.current.fn = fn;
        }
      }, [fn]);
      useEffect(function () {
        return function () {
          if (entryRef.current) {
            const i = ESC_STACK.indexOf(entryRef.current);
            if (i >= 0) ESC_STACK.splice(i, 1);
            entryRef.current = null;
          }
        };
      }, []);
    }

    // ─────────────────────────────────────────────────────────────
    // 图标（内联 SVG，16px，stroke currentColor）
    // ─────────────────────────────────────────────────────────────

    function icon(children, defaultSize) {
      return function IconComponent(props) {
        const s = (props && props.size) || defaultSize || 16;
        return h('svg', {
          width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
          style: Object.assign({ display: 'block', flex: 'none' }, (props && props.style) || {}),
        }, children);
      };
    }
    const IconPlus = icon([h('path', { key: 'a', d: 'M12 5v14' }), h('path', { key: 'b', d: 'M5 12h14' })]);
    const IconSearch = icon([h('circle', { key: 'c', cx: 11, cy: 11, r: 7 }), h('path', { key: 'p', d: 'M20.2 20.2L16 16' })]);
    const IconArchive = icon([
      h('path', { key: 'a', d: 'M3 8v10.5A1.5 1.5 0 0 0 4.5 20h15a1.5 1.5 0 0 0 1.5-1.5V8' }),
      h('path', { key: 'b', d: 'M2 4.5h20V8H2z' }),
      h('path', { key: 'c', d: 'M10 12h4' }),
    ]);
    const IconUnarchive = icon([
      h('path', { key: 'a', d: 'M3 8v10.5A1.5 1.5 0 0 0 4.5 20h15a1.5 1.5 0 0 0 1.5-1.5V8' }),
      h('path', { key: 'b', d: 'M2 4.5h20V8H2z' }),
      h('path', { key: 'c', d: 'M12 18.5v-6.8' }),
      h('path', { key: 'd', d: 'M9.4 14.1L12 11.5l2.6 2.6' }),
    ]);
    const IconRestore = icon([
      h('path', { key: 'a', d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
      h('path', { key: 'b', d: 'M21 3.5v6h-6' }),
    ]);
    const IconEdit = icon([
      h('path', { key: 'a', d: 'M12 20h9' }),
      h('path', { key: 'b', d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' }),
    ]);
    const IconTrash = icon([
      h('path', { key: 'a', d: 'M3 6h18' }),
      h('path', { key: 'b', d: 'M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6' }),
      h('path', { key: 'c', d: 'M18.5 6l-.9 13.1a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9L5.5 6' }),
      h('path', { key: 'd', d: 'M10 11v6M14 11v6' }),
    ]);
    const IconSave = icon([
      h('path', { key: 'a', d: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z' }),
      h('path', { key: 'b', d: 'M17 21v-8H7v8' }),
      h('path', { key: 'c', d: 'M7 3v5h8' }),
    ]);
    const IconDownload = icon([
      h('path', { key: 'a', d: 'M12 3v12' }),
      h('path', { key: 'b', d: 'M7 10l5 5 5-5' }),
      h('path', { key: 'c', d: 'M5 21h14' }),
    ]);
    const IconUpload = icon([
      h('path', { key: 'a', d: 'M12 21V9' }),
      h('path', { key: 'b', d: 'M7 14l5-5 5 5' }),
      h('path', { key: 'c', d: 'M5 3h14' }),
    ]);
    const IconClose = icon([h('path', { key: 'a', d: 'M18 6L6 18M6 6l12 12' })]);
    const IconBack = icon([h('path', { key: 'a', d: 'M19 12H5' }), h('path', { key: 'b', d: 'M12 19l-7-7 7-7' })]);
    const IconCheck = icon([h('path', { key: 'a', d: 'M20 6L9 17l-5-5' })]);
    const IconAlert = icon([
      h('circle', { key: 'a', cx: 12, cy: 12, r: 9 }),
      h('path', { key: 'b', d: 'M12 7.5v5.2' }),
      h('path', { key: 'c', d: 'M12 16.3h.01' }),
    ]);
    const IconChevron = icon([h('path', { key: 'a', d: 'M6 9l6 6 6-6' })]);
    const IconEye = icon([
      h('path', { key: 'a', d: 'M1.5 12S5.5 4.5 12 4.5 22.5 12 22.5 12 18.5 19.5 12 19.5 1.5 12 1.5 12z' }),
      h('circle', { key: 'b', cx: 12, cy: 12, r: 3 }),
    ]);
    const IconEyeOff = icon([
      h('path', { key: 'a', d: 'M17.94 17.94A10.07 10.07 0 0 1 12 19.5C5.5 19.5 1.5 12 1.5 12a18.45 18.45 0 0 1 5.06-5.94' }),
      h('path', { key: 'b', d: 'M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10.5 8 10.5 8a18.5 18.5 0 0 1-2.16 3.19' }),
      h('path', { key: 'c', d: 'M14.12 14.12a3 3 0 1 1-4.24-4.24' }),
      h('path', { key: 'd', d: 'M1.5 1.5l21 21' }),
    ]);

    function Spinner(props) {
      const s = (props && props.size) || 14;
      return h('span', {
        className: 'dswba-spin',
        style: Object.assign({ width: s, height: s }, (props && props.style) || {}),
        'aria-hidden': true,
      });
    }

    function Style() {
      return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
    }

    // ─────────────────────────────────────────────────────────────
    // 基础组件
    // ─────────────────────────────────────────────────────────────

    function Btn(props) {
      const cls = 'dswba-btn' +
        (props.variant ? ' dswba-' + props.variant : '') +
        (props.size === 'sm' ? ' dswba-sm' : '');
      return h('button', {
        type: 'button',
        className: cls,
        title: props.title || undefined,
        disabled: Boolean(props.disabled),
        onClick: props.disabled ? undefined : props.onClick,
        style: props.style,
      },
      props.icon ? h(props.icon, { size: props.iconSize || 14 }) : null,
      props.children);
    }

    function Field(props) {
      return h('div', { className: 'dswba-field' + (props.full ? ' full' : '') },
        h('label', { className: 'dswba-label' }, props.label),
        props.children,
        props.hint ? h('div', { className: 'dswba-label', style: { opacity: 0.85 } }, props.hint) : null);
    }

    // ─────────────────────────────────────────────────────────────
    // SelectBox：自建锚定下拉，替代全部原生 <select>。
    // 为什么不用原生 select：DSH 的 Android WebView 对原生 select 弹系统 picker，
    // 从屏幕边缘/底部「飞进来」，既不能继承主题样式，也不锚定在控件下方。
    // 结构：外层 .dswba-dd（position:relative）= 触发器 button + 菜单 div；
    // 菜单 position:absolute; top:calc(100% + 4px); left:0; right:0 —— 永远从触发器
    // 底边向下展开（宽度=触发器宽度）；不用 fixed / portal / 视口定位 / 滑入动画。
    // 交互：点击开合；点选项选中并关闭；点外部（document mousedown）关闭；Esc 关闭
    // （走全局 ESC_STACK，多层弹窗时只关最上层）；ArrowDown/ArrowUp 移动高亮、
    // Enter/Space 选中高亮项，收起时 ArrowDown/ArrowUp/Enter 也能展开；disabled 不展开。
    // 监听器全部在 effect 里随 open 加/移除，关闭与卸载都不泄漏。
    // props: value / options:[{value,label}] / onChange(value) / disabled /
    //        id / className(加在外层容器) / title / aria-label
    // ─────────────────────────────────────────────────────────────

    let ddSeq = 0;
    function SelectBox(props) {
      const options = Array.isArray(props.options) ? props.options : [];
      const value = props.value;
      const disabled = Boolean(props.disabled);
      const ariaLabel = props['aria-label'] || undefined;
      const [open, setOpen] = useState(false);
      const [hi, setHi] = useState(-1); // 高亮（键盘/悬停）选项下标
      const [uid] = useState(function () { ddSeq += 1; return 'dswba-dd-' + ddSeq; });
      const menuId = uid + '-menu';
      const rootRef = useRef(null);
      const btnRef = useRef(null);
      const listRef = useRef(null);
      const curIdx = options.findIndex(function (o) { return Boolean(o) && o.value === value; });
      const curLabel = curIdx >= 0 ? String(options[curIdx].label) : '';

      function focusTrigger() {
        try { if (btnRef.current) btnRef.current.focus(); } catch (e) { /* 忽略 */ }
      }
      function openMenu() {
        if (disabled) return;
        setHi(curIdx >= 0 ? curIdx : (options.length ? 0 : -1));
        setOpen(true);
      }
      function toggle() {
        if (disabled) return;
        if (open) setOpen(false);
        else openMenu();
      }
      function pick(i) {
        const o = options[i];
        if (!o) return;
        setOpen(false);
        if (o.value !== value && props.onChange) props.onChange(o.value);
        focusTrigger();
      }

      // 点外部关闭：仅打开期间挂 document mousedown，effect 清理即移除
      useEffect(function () {
        if (!open) return undefined;
        function onDocDown(e) {
          const root = rootRef.current;
          if (root && e.target && !root.contains(e.target)) setOpen(false);
        }
        try {
          document.addEventListener('mousedown', onDocDown);
        } catch (e) {
          return undefined; // 极端环境无 document：放弃点外部关闭
        }
        return function () {
          try { document.removeEventListener('mousedown', onDocDown); } catch (e) { /* 忽略 */ }
        };
      }, [open]);

      // Esc 关闭：复用全局 Esc 栈（与弹窗叠加时只关最上层）；关闭后焦点回触发器
      useEscSlot(open && !disabled ? function () { setOpen(false); focusTrigger(); } : null);

      // 变为禁用（如保存中）时强制收起，避免菜单悬在禁用触发器上
      useEffect(function () {
        if (disabled) setOpen(false);
      }, [disabled]);

      // 高亮项滚动进菜单可视区（jsdom 等无 scrollIntoView 的环境跳过）
      useEffect(function () {
        if (!open || hi < 0) return;
        try {
          const node = listRef.current && listRef.current.children[hi];
          if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
        } catch (e) { /* 忽略 */ }
      }, [open, hi]);

      function onKeyDown(e) {
        if (disabled) return;
        const k = e.key;
        if (!open) {
          // 收起时：ArrowDown/ArrowUp/Enter 展开（Space 走 button 原生 click）
          if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter') { e.preventDefault(); openMenu(); }
          return;
        }
        if (k === 'ArrowDown' && options.length) {
          e.preventDefault();
          setHi(function (i) { return (i + 1) % options.length; });
        } else if (k === 'ArrowUp' && options.length) {
          e.preventDefault();
          setHi(function (i) { return (i - 1 + options.length) % options.length; });
        } else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
          e.preventDefault(); // Space 同时挡掉 button 原生 click，避免「选中」变「开合」
          pick(hi >= 0 ? hi : curIdx);
        } else if (k === 'Escape') {
          // 兜底：在触发器上按 Esc 时只关菜单（全局捕获监听已处理同类路径；
          // 这里再兜一层，防止某些焦点/合成事件场景下菜单与设置面板一起被关）
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          focusTrigger();
        } else if (k === 'Tab') {
          setOpen(false); // 焦点离开时收起，避免菜单悬空
        }
      }

      return h('div', {
        className: 'dswba-dd' + (props.className ? ' ' + props.className : '') + (open ? ' open' : ''),
        ref: rootRef,
      },
      h('button', {
        type: 'button',
        ref: btnRef,
        id: props.id,
        className: 'dswba-dd-btn',
        disabled: disabled,
        title: props.title || undefined,
        'data-value': String(value == null ? '' : value),
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-label': ariaLabel,
        'aria-controls': open ? menuId : undefined,
        onClick: toggle,
        onKeyDown: onKeyDown,
      },
        h('span', { className: 'dswba-dd-value' }, curLabel),
        h('span', { className: 'dswba-dd-chev' }, h(IconChevron, { size: 14 }))),
      open && options.length
        ? h('div', {
          className: 'dswba-dd-menu', id: menuId, role: 'listbox', ref: listRef,
          'aria-label': ariaLabel,
          // 阻止菜单内 mousedown 默认行为：焦点留在触发器上，键盘导航不中断
          onMouseDown: function (e) { e.preventDefault(); },
        },
        options.map(function (o, i) {
          if (!o) return null;
          const sel = o.value === value;
          return h('div', {
            key: o.value != null ? String(o.value) : 'i' + i,
            role: 'option',
            'data-value': String(o.value),
            'aria-selected': sel,
            className: 'dswba-dd-opt' + (i === hi ? ' hi' : '') + (sel ? ' sel' : ''),
            onMouseEnter: function () { setHi(i); },
            onClick: function () { pick(i); },
          },
            h('span', { className: 'dswba-dd-opt-label' }, String(o.label)),
            sel ? h('span', { className: 'dswba-dd-check' }, h(IconCheck, { size: 13 })) : null);
        }))
        : null);
    }

    // 表单下拉的选项常量（模块级稳定数组，避免每次渲染重建）
    const PROTOCOL_OPTIONS = [
      { value: 'openai-completions', label: 'OpenAI 兼容 (Chat Completions)' },
      { value: 'anthropic-messages', label: 'Anthropic Messages' },
    ];
    const UNIT_OPTIONS = [
      { value: 'K', label: 'K' },
      { value: 'M', label: 'M' },
    ];
    const EFFORT_OPTIONS = [
      { value: 'max', label: 'Max（默认）' },
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
      { value: 'off', label: 'Off' },
    ];

    // 居中弹窗：Esc / 遮罩点击关闭都走 onRequestClose（null = 不可关闭）
    function Modal(props) {
      const onRequestClose = props.onRequestClose || null;
      useEscSlot(onRequestClose);
      return h('div', {
        className: 'dswba-modal-mask',
        onMouseDown: function (e) {
          if (e.target === e.currentTarget && onRequestClose) onRequestClose();
        },
      },
      h('div', {
        className: 'dswba-modal' + (props.wide ? ' dswba-wide' : ''),
        style: props.style,
        onMouseDown: function (e) { e.stopPropagation(); },
      },
      h('div', { className: 'dswba-modal-head' },
        h('div', { className: 'dswba-modal-title', title: props.title }, props.title),
        props.hideX
          ? null
          : h('button', {
            type: 'button', className: 'dswba-x', title: '关闭', 'aria-label': '关闭',
            onClick: onRequestClose || undefined,
            style: onRequestClose ? undefined : { visibility: 'hidden' },
          }, h(IconClose, { size: 16 }))),
      props.children));
    }

    // 二次确认弹窗（删除 / 清除 / 关闭运行中窗口共用）
    function ConfirmDialog(props) {
      const busy = Boolean(props.busy);
      const onCancel = props.onCancel || function () {};
      return h(Modal, {
        title: props.title || '确认',
        onRequestClose: busy ? null : onCancel,
      },
      h('div', { className: 'dswba-confirm-body' }, props.body || ''),
      h('div', { className: 'dswba-dlg-foot' },
        h(Btn, { onClick: onCancel, disabled: busy }, props.cancelText || '取消'),
        h(Btn, {
          variant: props.danger ? 'danger-solid' : 'primary',
          onClick: busy ? undefined : (props.onConfirm || function () {}),
          disabled: busy,
        }, busy ? '处理中…' : (props.confirmText || '确认'))));
    }

    // 名称 + 描述表单弹窗（编辑 / 保存为永久快照共用）
    function NameDescDialog(props) {
      const [name, setName] = useState(props.initialName || '');
      const [desc, setDesc] = useState(props.initialDesc || '');
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState(false);
      const onClose = props.onClose || function () {};
      async function submit() {
        const n = String(name || '').trim();
        if (!n) { setErr('请填写快照名称'); return; }
        if (n.length > 200) { setErr('名称不能超过 200 字符'); return; }
        if (String(desc || '').length > 2000) { setErr('描述不能超过 2000 字符'); return; }
        setBusy(true);
        setErr('');
        let j = null;
        try {
          j = await props.onSubmit({ name: n, description: String(desc || '').trim() });
        } catch (e) {
          j = { ok: false, error: '网络错误' };
        }
        setBusy(false);
        if (j && j.ok) onClose();
        else setErr((j && j.error) || '操作失败');
      }
      return h(Modal, { title: props.title || '', onRequestClose: busy ? null : onClose },
        props.note ? h('div', { className: 'dswba-dlg-note' }, props.note) : null,
        h(Field, { label: '快照名称' },
          h('input', {
            className: 'dswba-input', value: name, maxLength: 200, disabled: busy, autoFocus: true,
            onChange: function (e) { setName(e.target.value); },
          })),
        h('div', { style: { height: 12 } }),
        h(Field, { label: '快照描述' },
          h('textarea', {
            className: 'dswba-textarea', rows: 3, maxLength: 2000, value: desc, disabled: busy,
            placeholder: '记录这次快照的内容 / 为什么创建…',
            onChange: function (e) { setDesc(e.target.value); },
          })),
        err ? h('div', { className: 'dswba-errmsg' }, err) : null,
        h('div', { className: 'dswba-dlg-foot' },
          h(Btn, { onClick: onClose, disabled: busy }, '取消'),
          h(Btn, { variant: 'primary', onClick: submit, disabled: busy },
            busy ? '处理中…' : (props.confirmText || '保存'))));
    }

    // 创建流程第 1 步：名称（默认当前时间）+ 描述 →「下一步」
    function CreateDialog(props) {
      const [name, setName] = useState(defaultSnapshotName);
      const [desc, setDesc] = useState('');
      const [err, setErr] = useState('');
      const [needAi, setNeedAi] = useState(false);
      const canClose = props.canClose !== false;
      const onClose = props.onClose || function () {};
      function next() {
        const n = String(name || '').trim();
        if (!n) { setErr('请填写快照名称'); return; }
        if (n.length > 200) { setErr('名称不能超过 200 字符'); return; }
        if (String(desc || '').length > 2000) { setErr('描述不能超过 2000 字符'); return; }
        setErr('');
        if (!props.aiConfigured) { setNeedAi(true); return; }
        setNeedAi(false);
        if (props.onNext) props.onNext({ name: n, description: String(desc || '').trim() });
      }
      return h(Modal, { title: '创建新快照', onRequestClose: canClose ? onClose : null },
        h(Field, { label: '快照名称' },
          h('input', {
            className: 'dswba-input', value: name, maxLength: 200, autoFocus: true,
            placeholder: defaultSnapshotName(),
            onChange: function (e) { setName(e.target.value); setNeedAi(false); },
          })),
        h('div', { style: { height: 12 } }),
        h(Field, { label: '快照描述' },
          h('textarea', {
            className: 'dswba-textarea', rows: 3, maxLength: 2000, value: desc,
            placeholder: '记录这次快照的内容 / 为什么创建…',
            onChange: function (e) { setDesc(e.target.value); setNeedAi(false); },
          })),
        err ? h('div', { className: 'dswba-errmsg' }, err) : null,
        needAi
          ? h('div', { className: 'dswba-warn-row' },
            h(IconAlert, { size: 14 }),
            h('span', null, '请先在「高级设置」中配置 AI 模型'),
            h('button', {
              type: 'button', className: 'dswba-link',
              onClick: function () { if (props.onGoAdvanced) props.onGoAdvanced(); },
            }, '去配置'))
          : null,
        h('div', { className: 'dswba-dlg-foot' },
          h(Btn, { onClick: onClose, disabled: !canClose }, '取消'),
          h(Btn, { variant: 'primary', onClick: next }, '下一步')));
    }

    // ─────────────────────────────────────────────────────────────
    // AI 输出窗口：按 kind 着色；用户未上翻时自动滚到底
    // ─────────────────────────────────────────────────────────────

    function OutputBox(props) {
      const lines = Array.isArray(props.lines) ? props.lines : [];
      const ref = useRef(null);
      const stick = useRef(true);
      useEffect(function () {
        const node = ref.current;
        if (!node || !stick.current) return;
        try { node.scrollTop = node.scrollHeight; } catch (e) { /* 忽略 */ }
      }, [lines]);
      const onScroll = useCallback(function () {
        const node = ref.current;
        if (!node) return;
        stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 36;
      }, []);
      return h('div', {
        className: 'dswba-out', ref: ref, style: props.style, onScroll: onScroll,
      },
      lines.length
        ? lines.map(function (line, i) {
          const kind = (line && line.kind) || 'assistant';
          const cls = kind === 'tool' || kind === 'system' || kind === 'error' ? kind : 'assistant';
          const prefix = cls === 'tool' ? '› ' : cls === 'system' ? '▸ ' : '';
          return h('span', {
            key: line && line.seq != null ? 'l' + line.seq : 'i' + i,
            className: 'dswba-line ' + cls,
          }, prefix + String((line && line.text) || ''));
        })
        : h('span', { className: 'dswba-line idle' }, props.idleText || '等待 AI 输出…'));
    }

    // ─────────────────────────────────────────────────────────────
    // 多功能进度按钮（核心状态机）
    //   idle(蓝「创建快照/开始恢复」) → starting → running(进度+流光, hover 淡红「中断」)
    //   → 点击中断 → interrupting(进度 ~1.2s 回退到 0) → interrupted(实红「中断成功」)
    //   running → done(淡绿「完成」) / failed(淡红「失败」+error)
    // 状态同步来源是 STORE 的 run；本地 starting/rolling 做覆盖，防止重复点击。
    // ─────────────────────────────────────────────────────────────

    function RunButton(props) {
      const run = props.run || null;
      const onStart = props.onStart || null;
      const [starting, setStarting] = useState(false);
      const [rolling, setRolling] = useState(null); // 中断回退中的进度（null=未在回退）
      const [acting, setActing] = useState(false);  // 中断 POST 进行中
      const [err, setErr] = useState('');
      const rollTimer = useRef(null);
      const watchdog = useRef(null);
      const seenId = useRef(undefined);
      const status = run ? run.status : null;
      const runId = (run && run.id) || null;

      useEffect(function () {
        return function () {
          if (rollTimer.current) clearInterval(rollTimer.current);
          if (watchdog.current) clearTimeout(watchdog.current);
        };
      }, []);

      // run 切换 → 清掉本地覆盖态
      useEffect(function () {
        if (runId !== seenId.current) {
          seenId.current = runId;
          if (rollTimer.current) { clearInterval(rollTimer.current); rollTimer.current = null; }
          setRolling(null);
          setActing(false);
          setErr('');
        }
      }, [runId]);

      // starting → run 已出现（任意状态都算启动成功；终态直接展示结果）
      useEffect(function () {
        if (starting && run && (status === 'running' || status === 'done' || status === 'failed' || status === 'interrupted')) {
          setStarting(false);
          if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null; }
        }
      }, [starting, runId, status]);

      const hostProgress = run && typeof run.progress === 'number'
        ? Math.max(0, Math.min(100, Math.round(run.progress)))
        : 0;
      const rollingActive = rolling !== null;
      const progress = rollingActive ? rolling : hostProgress;

      let mode = 'idle';
      if (starting) mode = 'starting';
      // 回退动画中：Host 尚未落终态（或刚落 interrupted）都继续显示「正在中断…」；
      // 但若 Host 以 done/failed 收尾（中断与完成/失败竞态），终态优先，避免按钮卡死
      else if (rollingActive && rolling > 0 && status !== 'failed' && status !== 'done') mode = 'interrupting';
      else if (rollingActive && rolling <= 0 && status === 'running') mode = 'interrupting';
      else if (status === 'interrupted') mode = 'interrupted';
      else if (status === 'done') mode = 'done';
      else if (status === 'failed') mode = 'failed';
      else if (status === 'running') mode = 'running';

      const canAbort = !(run && run.canAbort === false);
      const isRestore = Boolean(run && run.kind === 'restore') || props.kind === 'restore';
      const abortLabel = props.abortLabel || (isRestore ? '中断恢复' : '中断快照');
      const doneLabel = props.doneLabel || (isRestore ? '恢复完成' : '快照完成');
      const interruptedLabel = props.interruptedLabel || (isRestore ? '中断恢复成功' : '中断快照成功');
      const failedLabel = props.failLabel || (isRestore ? '恢复失败' : '快照失败');

      // 中断回退动画：约 1.2s 内从当前值线性退到 0（24 拍 × 50ms）
      function beginRollback(from) {
        if (rollTimer.current) { clearInterval(rollTimer.current); rollTimer.current = null; }
        const start = Math.max(0, Number(from) || 0);
        setRolling(start);
        if (start <= 0) return;
        const step = Math.max(1, Math.ceil(start / 24));
        let v = start;
        rollTimer.current = setInterval(function () {
          v -= step;
          if (v <= 0) {
            v = 0;
            if (rollTimer.current) { clearInterval(rollTimer.current); rollTimer.current = null; }
          }
          setRolling(v);
        }, 50);
      }

      async function clickHandler() {
        if (mode === 'idle') {
          if (!onStart || starting) return;
          setErr('');
          setStarting(true);
          if (watchdog.current) clearTimeout(watchdog.current);
          watchdog.current = setTimeout(function () {
            watchdog.current = null;
            setStarting(false);
            setErr('任务启动超时，请重试');
          }, 12000);
          let j = null;
          try { j = await onStart(); } catch (e) { j = { ok: false, error: '网络错误，启动失败' }; }
          if (!j || !j.ok) {
            setStarting(false);
            if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null; }
            setErr((j && j.error) || '启动失败');
          }
          return;
        }
        if (mode === 'running') {
          if (acting || !canAbort || !run) return;
          setActing(true);
          setErr('');
          const from = hostProgress;
          const path = run.kind === 'restore' ? '/dsh-backup-all/restore/abort' : '/dsh-backup-all/snapshot/abort';
          let j = null;
          try { j = await postJSON(path, { runId: run.id }); } catch (e) { j = { ok: false, error: '网络错误' }; }
          setActing(false);
          if (j && j.ok) {
            beginRollback(from);
            STORE.refresh();
          } else {
            setErr((j && j.error) || '中断失败');
          }
          return;
        }
        // starting / interrupting / interrupted / done / failed：点击无动作
      }

      const label =
        mode === 'idle' ? (props.idleLabel || (isRestore ? '开始恢复' : '创建快照'))
          : mode === 'starting' ? '正在启动…'
            : mode === 'running' ? progress + '%' + (run && run.phase ? '  ' + run.phase : '')
              : mode === 'interrupting' ? '正在中断…'
                : mode === 'interrupted' ? interruptedLabel
                  : mode === 'done' ? doneLabel
                    : failedLabel;

      const showFill = mode === 'running' || mode === 'interrupting';
      const fillPct = mode === 'done' ? 100 : Math.max(0, Math.min(100, progress));
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'dswba-runbtn dswba-st-' + mode + (mode === 'running' && !canAbort ? ' dswba-noabort' : ''),
          disabled: mode === 'starting',
          onClick: mode === 'idle' || mode === 'running' ? clickHandler : undefined,
        },
        showFill || mode === 'done'
          ? h('span', { className: 'dswba-fill', style: { width: fillPct + '%' } })
          : null,
        mode === 'running'
          ? h('span', { className: 'dswba-sheen-anchor', style: { left: fillPct + '%' } },
            h('span', { className: 'dswba-sheen' }))
          : null,
        h('span', { className: 'dswba-run-label' },
          mode === 'starting' || mode === 'interrupting' ? h(Spinner, { size: 14 }) : null,
          mode === 'running' ? h(Spinner, { size: 14 }) : null,
          mode === 'done' ? h(IconCheck, { size: 15 }) : null,
          mode === 'failed' ? h(IconAlert, { size: 15 }) : null,
          label),
        h('span', { className: 'dswba-run-hover' }, h(IconClose, { size: 15 }), abortLabel)),
        err ? h('div', { className: 'dswba-errmsg' }, err) : null);
    }

    // ─────────────────────────────────────────────────────────────
    // 运行窗口（创建第 2 步 / 恢复窗口 / 状态条观察窗 / 悬浮进程面板共用）
    //   modal=true  → 居中弹窗 760px；运行中关闭先确认「可在悬浮球继续查看」
    //   modal=false → 内容直接嵌入悬浮进程面板（flex 撑满）
    // ─────────────────────────────────────────────────────────────

    function RunWindow(props) {
      const modal = Boolean(props.modal);
      const watch = Boolean(props.watch);
      const kind = props.kind || 'snapshot';
      const startFn = props.startFn || null;
      const onClose = props.onClose || function () {};
      useStore();
      const [myRunId, setMyRunId] = useState(props.initialRunId || null);
      const [confirmClose, setConfirmClose] = useState(false);
      const liveRun = pickRun(STORE.state && STORE.state.run, myRunId, watch ? null : kind);
      const lastRef = useRef(null);
      if (liveRun) lastRef.current = liveRun;
      const run = liveRun || (watch ? lastRef.current : null);
      const status = run ? run.status : null;
      const active = status === 'running';
      const isRestore = watch ? Boolean(run && run.kind === 'restore') : kind === 'restore';
      const shownName = props.titleName || (run && run.snapshotName) || '';
      const lines = run && STORE.logRunId === run.id && Array.isArray(STORE.log) ? STORE.log : [];

      const handleStart = useCallback(async function () {
        if (!startFn) return { ok: false, error: '当前没有可启动的任务' };
        const j = await startFn();
        if (j && j.ok && j.runId) {
          setMyRunId(j.runId);
          lastRef.current = null;
          STORE.refresh();
        }
        return j;
      }, [startFn]);

      function doClose() {
        setConfirmClose(false);
        try { onClose(); } catch (e) { /* 忽略 */ }
      }
      function requestClose() {
        // 运行中先确认：任务不会因关窗停止，可继续在悬浮球查看
        if (active && modal) { setConfirmClose(true); return; }
        doClose();
      }

      const hint = active
        ? h('span', { className: 'dswba-run-hint' }, h(Spinner, { size: 12 }), 'AI 正在工作…')
        : status === 'done'
          ? h('span', { className: 'dswba-run-hint' }, '已完成')
          : status === 'interrupted'
            ? h('span', { className: 'dswba-run-hint' }, '已中断')
            : status === 'failed'
              ? h('span', { className: 'dswba-run-hint' }, '已失败')
              : null;

      const body = h('div', { className: modal ? undefined : 'dswba-panel-body' },
        isRestore
          ? h('div', { className: 'dswba-swnote' }, '恢复前会先自动为当前环境创建「恢复前快照」，恢复过程中可中断。')
          : h('div', { className: 'dswba-swnote' }, 'AI 会扫描已安装的插件 / Skill / MCP / Agent Preset，找出外部文件、写恢复说明，然后高压缩打包。运行中可随时中断。'),
        watch && !run ? h('div', { className: 'dswba-swnote' }, '当前没有正在运行的任务。') : null,
        h(OutputBox, {
          lines: lines,
          idleText: active || status ? '等待 AI 输出…' : '点击底部按钮开始，AI 输出会显示在这里',
        }),
        watch && !run
          ? null
          : h(RunButton, {
            run: run,
            kind: kind,
            onStart: startFn ? handleStart : null,
            idleLabel: isRestore ? '开始恢复' : '创建快照',
          }),
        status === 'failed' && run && run.error
          ? h('div', { className: 'dswba-run-error' }, String(run.error))
          : null,
        status === 'done' && isRestore
          ? h('div', { className: 'dswba-run-tip' }, '部分插件变更需要重启 DSH 后生效')
          : null,
        status === 'done' && run && run.summary
          ? h('div', { className: 'dswba-run-summary' }, truncate(run.summary, 300))
          : null,
        status === 'done' || status === 'failed' || status === 'interrupted'
          ? h('div', { className: 'dswba-run-close' },
            h(Btn, { onClick: doClose, style: { height: 34, padding: '0 24px' } }, '关闭'))
          : null);

      if (modal) {
        return h(Modal, {
          title: (isRestore ? '恢复快照：' : '创建快照：') + shownName,
          wide: true,
          onRequestClose: requestClose,
        },
        hint ? h('div', { style: { marginTop: -8, marginBottom: 10, display: 'flex', justifyContent: 'flex-end' } }, hint) : null,
        body,
        confirmClose
          ? h(ConfirmDialog, {
            title: '任务仍在进行',
            body: '关闭窗口后可在悬浮球继续查看任务进度。',
            confirmText: '关闭窗口',
            cancelText: '继续等待',
            onConfirm: doClose,
            onCancel: function () { setConfirmClose(false); },
          })
          : null);
      }

      // 悬浮进程面板形态：标题行在面板内渲染（· 分隔），右上角 ×
      return h(React.Fragment, null,
        h('div', { className: 'dswba-modal-head', style: { marginBottom: 10 } },
          h('div', { className: 'dswba-modal-title', title: shownName },
            (isRestore ? '恢复快照' : '创建快照') + ' · ' + shownName),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' } },
            hint,
            h('button', {
              type: 'button', className: 'dswba-x', title: '关闭', 'aria-label': '关闭', onClick: doClose,
            }, h(IconClose, { size: 16 })))),
        body);
    }

    // ─────────────────────────────────────────────────────────────
    // 快照卡片（列表 / 已归档共用；v1.1.0：名称旁 OS 徽章 + 操作组「导出」；
    // 已归档为「取消归档」「导出」「删除」）
    // ─────────────────────────────────────────────────────────────

    // 导出快照文件：优先 Blob 下载；WebView 不支持/能力缺失时回退直接导航（cookie 同源）
    async function exportSnapshotRecord(record, showToast) {
      if (!record || !record.id) return false;
      const exportUrl = '/dsh-backup-all/snapshot/export?id=' + encodeURIComponent(record.id);
      const fallbackNavigate = function (note) {
        try {
          if (typeof window !== 'undefined' && window.location) {
            if (note) showToast(note);
            window.location.href = exportUrl;
            return true;
          }
        } catch (e) { /* 忽略 */ }
        return false;
      };
      // 客户端能力缺失（fetch 不存在）→ 直接导航
      if (typeof fetch !== 'function') {
        return fallbackNavigate('当前环境不支持脚本下载，已尝试直接打开下载链接');
      }
      let res = null;
      try {
        res = await fetch(exportUrl);
      } catch (e) {
        // 网络/fetch 异常：尝试直接导航（可能是 WebView 对 fetch 的限制）
        return fallbackNavigate('下载请求失败，已尝试直接打开下载链接');
      }
      if (!res) return fallbackNavigate('下载请求无响应，已尝试直接打开下载链接');
      // 服务端明确报错：只 toast，不误导用户跳转
      let ct = '';
      try { ct = String((res.headers && res.headers.get ? res.headers.get('content-type') : '') || ''); } catch (e) { ct = ''; }
      if (!res.ok || ct.indexOf('json') >= 0) {
        const t = await res.text().catch(function () { return ''; });
        let j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        showToast('导出失败：' + ((j && j.error) || ('HTTP ' + res.status)));
        return false;
      }
      // blob 能力缺失/blob 读取失败 → fallback 导航
      if (typeof res.blob !== 'function') {
        return fallbackNavigate('当前环境不支持 Blob 下载，已尝试直接打开下载链接');
      }
      let blob = null;
      try {
        blob = await res.blob();
      } catch (e) {
        return fallbackNavigate('读取下载内容失败，已尝试直接打开下载链接');
      }
      const URLobj = (typeof window !== 'undefined' && window.URL) ? window.URL : (typeof URL !== 'undefined' ? URL : null);
      if (URLobj && typeof URLobj.createObjectURL === 'function' && typeof document !== 'undefined') {
        const objUrl = URLobj.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = record.file || 'snapshot.backup.tar.br';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          try { a.remove(); URLobj.revokeObjectURL(objUrl); } catch (e) { /* 忽略 */ }
        }, 1500);
        showToast('已开始导出');
        return true;
      }
      return fallbackNavigate('当前环境不支持 Blob 下载，已尝试直接打开下载链接');
    }

    // OS 徽章：windows 蓝 / linux 橙 / 旧版灰
    function osBadgeNode(osType) {
      const t = String(osType || 'unknown').toLowerCase();
      if (t === 'windows') return h('span', { className: 'dswba-os-badge dswba-os-windows', title: 'Windows 快照' }, 'Windows');
      if (t === 'linux') return h('span', { className: 'dswba-os-badge dswba-os-linux', title: 'Linux 快照' }, 'Linux');
      if (t === 'other') return h('span', { className: 'dswba-os-badge dswba-os-unknown', title: '其它系统快照' }, 'Other');
      return h('span', { className: 'dswba-os-badge dswba-os-unknown', title: '旧版快照（未记录系统类型）' }, '旧版');
    }

    // 引入快照弹窗：选择 .backup.tar.br → 默认名称=去后缀文件名 → 上传
    function ImportSnapshotDialog(props) {
      const showToast = props.showToast || function () {};
      const fileRef = useRef(null);
      const [file, setFile] = useState(null);
      const [name, setName] = useState('');
      const [description, setDescription] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const MAX = 512 * 1024 * 1024;

      function pickFile() {
        if (busy) return;
        if (fileRef.current) fileRef.current.click();
      }
      function onFileChange(e) {
        const f = e.target && e.target.files && e.target.files[0];
        if (!f) return;
        const reject = function (msg) {
          setFile(null);
          setName('');
          setError(msg);
          try { if (e.target) e.target.value = ''; } catch (err) { /* 忽略 */ }
        };
        if (!/\.(backup\.)?tar\.br$/i.test(String(f.name || ''))) {
          reject('请选择 .backup.tar.br / .tar.br 快照文件');
          return;
        }
        if (f.size === 0) {
          reject('快照文件为空');
          return;
        }
        if (f.size > MAX) {
          reject('快照文件过大（上限 512 MiB）');
          return;
        }
        setFile(f);
        setError('');
        // 每次选择文件都刷新默认名（用户仍可手工修改）
        setName(String(f.name || '').replace(/\.backup\.tar\.br$/i, '').replace(/\.tar\.br$/i, ''));
      }
      async function submit() {
        if (busy) return;
        if (!file) { setError('请先选择快照文件'); return; }
        const finalName = String(name || '').trim();
        if (!finalName) { setError('名称不能为空'); return; }
        setBusy(true);
        setError('');
        try {
          const sendName = finalName;
          const sendDesc = String(description || '').trim();
          const res = await fetch('/dsh-backup-all/snapshot/import', {
            method: 'POST',
            headers: {
              'content-type': 'application/octet-stream',
              'x-snapshot-filename': encodeURIComponent(String(file.name || '')),
              'x-snapshot-name': encodeURIComponent(sendName),
              'x-snapshot-description': encodeURIComponent(sendDesc),
            },
            body: file,
          });
          const textBody = await res.text().catch(function () { return ''; });
          let j = null;
          try { j = JSON.parse(textBody); } catch (e) { j = null; }
          if (j && j.ok) {
            showToast('已引入快照');
            if (props.onImported) props.onImported(j.record);
            return;
          }
          setError((j && j.error) || ('引入失败（HTTP ' + res.status + '）'));
        } catch (e) {
          setError('网络错误，请重试');
        } finally {
          setBusy(false);
        }
      }

      return h(Modal, {
        title: '引入快照',
        onRequestClose: busy ? null : props.onClose,
      },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('input', {
          type: 'file', accept: '.backup.tar.br,.tar.br', ref: fileRef, disabled: busy,
          style: { display: 'none' }, onChange: onFileChange,
        }),
        h('div', {
          className: 'dswba-field',
          onClick: busy ? undefined : pickFile,
        },
          h('div', { className: 'dswba-label' }, '快照文件'),
          h('div', {
            className: 'dswba-import-file' + (file ? ' hasFile' : ''),
            role: 'button', tabIndex: 0,
            onKeyDown: function (e) { if (busy) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); } },
          },
            h(IconUpload, { size: 14 }),
            h('span', { className: 'dswba-import-file-name', title: file ? file.name : '' },
              file ? file.name : '点击选择 .backup.tar.br 文件'),
            file ? h('span', { className: 'dswba-import-hint', style: { flex: 'none' } }, formatSize(file.size)) : null,
          ),
          h('div', { className: 'dswba-import-hint' },
            '支持本插件导出的快照文件；引入后会复制到本机快照目录并按文件名/清单识别系统类型。')),
        h('label', { className: 'dswba-field' },
          h('span', { className: 'dswba-label' }, '名称'),
          h('input', {
            className: 'dswba-input', value: name, maxLength: 200, disabled: busy,
            placeholder: '默认为文件名去掉 .backup.tar.br 后缀',
            onChange: function (e) { setName(e.target.value); },
          })),
        h('label', { className: 'dswba-field' },
          h('span', { className: 'dswba-label' }, '描述（可选）'),
          h('textarea', {
            className: 'dswba-textarea', value: description, maxLength: 2000, disabled: busy,
            placeholder: '例如：从旧机器导出的快照',
            onChange: function (e) { setDescription(e.target.value); },
          })),
        error ? h('div', { className: 'dswba-import-error' }, error) : null,
        h('div', { className: 'dswba-form-foot' },
          h(Btn, { onClick: busy ? undefined : props.onClose, disabled: busy }, '取消'),
          h(Btn, { variant: 'primary', onClick: submit, disabled: busy || !file }, busy ? '引入中…' : '引入')),
      ));
    }

    function SnapshotCard(props) {
      const record = props.record || {};
      const archivedView = Boolean(props.archivedView);
      const isPre = record.kind === 'pre-restore';
      const busy = Boolean(props.busy);
      const sizeText = record.bytes != null ? formatSize(record.bytes) : (record.sizeText || '');
      return h('div', { className: 'dswba-card' },
        h('div', { className: 'dswba-card-top' },
          h('div', { style: { minWidth: 0, flex: 1 } },
            h('div', { className: 'dswba-card-title' },
              h('div', { className: 'dswba-card-name', title: record.name || '' }, record.name || '（未命名）'),
              osBadgeNode(record.osType)),
            h('div', { className: 'dswba-card-time' }, formatTime(record.createdAt))),
          isPre ? h('span', { className: 'dswba-chip' }, '恢复前快照') : null),
        h('div', { className: 'dswba-card-desc' }, record.description || '（无描述）'),
        isPre && !archivedView && props.onPromote
          ? h('div', { className: 'dswba-promote' },
            h(Btn, { size: 'sm', icon: IconSave, disabled: busy, style: { width: '100%' }, onClick: function () { props.onPromote(record); } },
              '保存为永久快照'))
          : null,
        h('div', { className: 'dswba-card-foot' },
          h('span', { className: 'dswba-card-size' }, sizeText),
          h('div', { className: 'dswba-card-actions' },
            archivedView
              ? [
                h(Btn, {
                  key: 'unarchive', size: 'sm', icon: IconUnarchive, disabled: busy,
                  onClick: function () { if (props.onUnarchive) props.onUnarchive(record); },
                }, '取消归档'),
                h(Btn, {
                  key: 'export', size: 'sm', icon: IconDownload,
                  disabled: busy || Boolean(props.exporting),
                  onClick: function () { if (props.onExport) props.onExport(record); },
                }, props.exporting ? '导出中…' : '导出'),
                h(Btn, {
                  key: 'delete', size: 'sm', variant: 'danger', icon: IconTrash, disabled: busy,
                  onClick: function () { if (props.onDelete) props.onDelete(record); },
                }, '删除'),
              ]
              : [
                h(Btn, {
                  key: 'edit', size: 'sm', icon: IconEdit, disabled: busy,
                  onClick: function () { if (props.onEdit) props.onEdit(record); },
                }, '编辑'),
                h(Btn, {
                  key: 'archive', size: 'sm', icon: IconArchive, disabled: busy,
                  onClick: function () { if (props.onArchive) props.onArchive(record); },
                }, '归档'),
                h(Btn, {
                  key: 'restore', size: 'sm', icon: IconRestore,
                  disabled: busy || Boolean(props.runActive),
                  title: props.runActive ? '已有任务正在运行' : undefined,
                  onClick: function () { if (props.onRestore) props.onRestore(record); },
                }, '恢复'),
                h(Btn, {
                  key: 'export', size: 'sm', icon: IconDownload,
                  disabled: busy || Boolean(props.exporting),
                  onClick: function () { if (props.onExport) props.onExport(record); },
                }, props.exporting ? '导出中…' : '导出'),
              ])));
    }

    // ─────────────────────────────────────────────────────────────
    // 快照列表页
    // ─────────────────────────────────────────────────────────────

    function SnapshotsPage(props) {
      const records = props.records || [];
      const run = props.run || null;
      const runActive = Boolean(props.runActive);
      const showToast = props.showToast || function () {};
      const [query, setQuery] = useState('');
      const [busyId, setBusyId] = useState(null);
      const [exportId, setExportId] = useState(null);
      const [importOpen, setImportOpen] = useState(false);

      async function doExport(record) {
        if (!record || !record.id || exportId) return;
        setExportId(record.id);
        try {
          await exportSnapshotRecord(record, showToast);
        } finally {
          setExportId(null);
        }
      }

      const q = String(query || '').trim().toLowerCase();
      let list = records.filter(function (r) { return r && !r.archived; });
      if (q) {
        list = list.filter(function (r) {
          return (String(r.name || '') + ' ' + String(r.description || '')).toLowerCase().indexOf(q) >= 0;
        });
      }
      list = sortPreFirst(list);

      async function doArchive(record) {
        setBusyId(record.id);
        const j = await postJSON('/dsh-backup-all/snapshot/archive', { id: record.id, archived: true });
        setBusyId(null);
        if (!j || !j.ok) showToast('归档失败：' + ((j && j.error) || '未知错误'));
        else showToast('已归档');
        STORE.refresh();
      }

      return h(React.Fragment, null,
        h('div', { className: 'dswba-toolbar' },
          h('div', { className: 'dswba-search' },
            h(IconSearch, { size: 14 }),
            h('input', {
              value: query, placeholder: '搜索快照名称 / 描述',
              onChange: function (e) { setQuery(e.target.value); },
            })),
          h(Btn, {
            variant: 'primary', icon: IconPlus, disabled: runActive,
            title: runActive ? '已有任务正在运行' : undefined,
            onClick: function () { if (props.onOpenCreate) props.onOpenCreate(); },
          }, '创建新快照'),
          h(Btn, {
            icon: IconUpload,
            onClick: function () { setImportOpen(true); },
          }, '引入快照'),
          h('div', { className: 'dswba-spacer' }),
          h(Btn, {
            icon: IconArchive,
            onClick: function () { if (props.onOpenArchived) props.onOpenArchived(); },
          }, '已归档' + (props.archivedCount ? '（' + props.archivedCount + '）' : ''))),
        run && run.status === 'running'
          ? h('div', {
            className: 'dswba-statusbar', title: '点击打开进程窗口',
            onClick: function () { if (props.onWatch) props.onWatch(); },
          },
          h('span', { className: 'dswba-dot' }),
          h('span', { className: 'dswba-statusbar-txt' },
            (run.kind === 'restore' ? '正在恢复快照：' : '正在创建快照：') +
            (run.snapshotName || '') + ' — ' + (run.phase || '') + ' ' +
            ((run.progress != null ? run.progress : 0) + '%')))
          : null,
        list.length
          ? h('div', { className: 'dswba-grid' },
            list.map(function (record) {
              return h(SnapshotCard, {
                key: record.id, record: record, busy: busyId === record.id, runActive: runActive,
                exporting: exportId === record.id, onExport: doExport,
                onEdit: props.onEdit, onRestore: props.onRestore,
                onPromote: props.onPromote, onArchive: doArchive,
              });
            }))
          : h('div', { className: 'dswba-empty' },
            h(IconArchive, { size: 40, style: { opacity: 0.5 } }),
            h('div', { className: 'dswba-empty-title' }, q ? '没有匹配的快照' : '还没有快照'),
            h('div', { className: 'dswba-empty-sub' }, q ? '换个关键词试试' : '点击右上角「创建新快照」开始')),
        importOpen
          ? h(ImportSnapshotDialog, {
            showToast: showToast,
            onClose: function () { setImportOpen(false); },
            onImported: function () { setImportOpen(false); STORE.refresh(); },
          })
          : null);
    }

    // ─────────────────────────────────────────────────────────────
    // 已归档视图：取消归档 / 导出 / 删除（删除二次确认）
    // ─────────────────────────────────────────────────────────────

    function ArchivedPage(props) {
      const records = props.records || [];
      const showToast = props.showToast || function () {};
      const [busyId, setBusyId] = useState(null);
      const [delTarget, setDelTarget] = useState(null);
      const [delBusy, setDelBusy] = useState(false);
      const [exportId, setExportId] = useState(null);

      async function doExport(record) {
        if (!record || !record.id || exportId) return;
        setExportId(record.id);
        try {
          await exportSnapshotRecord(record, showToast);
        } finally {
          setExportId(null);
        }
      }

      const q = String(props.query || '').trim().toLowerCase();
      let list = records.filter(function (r) { return r && r.archived !== false; });
      if (q) {
        list = list.filter(function (r) {
          return (String(r.name || '') + ' ' + String(r.description || '')).toLowerCase().indexOf(q) >= 0;
        });
      }
      list = sortPreFirst(list);

      async function doUnarchive(record) {
        setBusyId(record.id);
        const j = await postJSON('/dsh-backup-all/snapshot/archive', { id: record.id, archived: false });
        setBusyId(null);
        if (!j || !j.ok) showToast('操作失败：' + ((j && j.error) || '未知错误'));
        else showToast('已取消归档');
        STORE.refresh();
      }
      async function doDelete() {
        if (!delTarget) return;
        setDelBusy(true);
        const j = await postJSON('/dsh-backup-all/snapshot/delete', { id: delTarget.id });
        setDelBusy(false);
        if (j && j.ok) { setDelTarget(null); showToast('已删除'); }
        else showToast('删除失败：' + ((j && j.error) || '未知错误'));
        STORE.refresh();
      }

      return h(React.Fragment, null,
        h('div', { className: 'dswba-toolbar' },
          h(Btn, { variant: 'ghost', icon: IconBack, onClick: function () { if (props.onBack) props.onBack(); } }, '返回快照列表'),
          h('div', { style: { fontSize: 14, fontWeight: 650, marginLeft: 6 } }, '已归档'),
          h('div', { className: 'dswba-spacer' }),
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, list.length + ' 个')),
        list.length
          ? h('div', { className: 'dswba-grid' },
            list.map(function (record) {
              return h(SnapshotCard, {
                key: record.id, record: record, busy: busyId === record.id, archivedView: true,
                exporting: exportId === record.id, onExport: doExport,
                onUnarchive: doUnarchive, onDelete: setDelTarget,
              });
            }))
          : h('div', { className: 'dswba-empty' },
            h(IconArchive, { size: 36, style: { opacity: 0.5 } }),
            h('div', { className: 'dswba-empty-title' }, '没有已归档的快照'),
            h('div', { className: 'dswba-empty-sub' }, '在快照列表点「归档」后，快照会移动到这里（压缩包不会删除）')),
        delTarget
          ? h(ConfirmDialog, {
            title: '删除快照',
            body: '删除后压缩包文件也会被删除，确定？\n\n「' + (delTarget.name || '未命名快照') + '」',
            confirmText: '删除', danger: true, busy: delBusy,
            onConfirm: doDelete,
            onCancel: function () { setDelTarget(null); },
          })
          : null);
    }

    // ─────────────────────────────────────────────────────────────
    // 高级设置：AI 配置（长按钮 + 展开表单）+ 快照策略卡片 + 清除所有快照
    // ─────────────────────────────────────────────────────────────

    function AiConfigForm(props) {
      const ai = props.ai || {};
      const showToast = props.showToast || function () {};
      const [form, setForm] = useState(function () { return build(ai); });
      const [showKey, setShowKey] = useState(false);
      const [busy, setBusy] = useState('');
      const [result, setResult] = useState(null); // {ok, text}
      const [savedFlash, setSavedFlash] = useState(false);
      const savedTimer = useRef(null);
      useEffect(function () {
        return function () { if (savedTimer.current) clearTimeout(savedTimer.current); };
      }, []);
      // Host 设置变化（保存/测试后轮询回来）时同步表单，但不打断正在输入的 apiKey
      useEffect(function () {
        setForm(function (prev) {
          const next = build(ai);
          next.apiKey = prev.apiKey;
          return next;
        });
      }, [ai.baseURL, ai.modelId, ai.protocol, ai.contextWindow, ai.maxOutput, ai.effort, ai.hasApiKey]);

      function build(src) {
        const s = src || {};
        const cw = tokenToForm(s.contextWindow, 1000, 'K');
        const mo = tokenToForm(s.maxOutput, 64, 'K');
        return {
          baseURL: s.baseURL || '',
          protocol: s.protocol || 'openai-completions',
          apiKey: '',
          modelId: s.modelId || '',
          contextWindowValue: cw.value,
          contextWindowUnit: cw.unit,
          maxOutputValue: mo.value,
          maxOutputUnit: mo.unit,
          effort: s.effort || 'max',
        };
      }
      function patch(key, value) {
        setForm(function (prev) { return Object.assign({}, prev, { [key]: value }); });
        setResult(null);
      }
      function payload() {
        const body = {
          baseURL: String(form.baseURL || '').trim(),
          protocol: form.protocol,
          modelId: String(form.modelId || '').trim(),
          contextWindowValue: Number(form.contextWindowValue) || 0,
          contextWindowUnit: form.contextWindowUnit,
          maxOutputValue: Number(form.maxOutputValue) || 0,
          maxOutputUnit: form.maxOutputUnit,
          effort: form.effort,
        };
        const k = String(form.apiKey || '').trim();
        if (k) body.apiKey = k; // 留空 = 不修改已保存的 Key（契约 12）
        return body;
      }
      function validate() {
        if (!String(form.baseURL || '').trim()) return '请填写 API Base URL';
        if (!String(form.modelId || '').trim()) return '请填写 AI Model ID';
        if (!(Number(form.contextWindowValue) > 0)) return '上下文窗口大小需为正数';
        if (!(Number(form.maxOutputValue) > 0)) return '最大输出大小需为正数';
        return '';
      }
      async function doTest() {
        const v = validate();
        if (v) { setResult({ ok: false, text: v }); return; }
        setBusy('test');
        setResult(null);
        const j = await postJSON('/dsh-backup-all/settings/test', payload());
        setBusy('');
        if (j && j.ok) {
          setResult({
            ok: true,
            text: '连接成功 · ' + (j.latencyMs != null ? j.latencyMs + 'ms' : '—') +
              ' · ' + (j.modelId || String(form.modelId || '').trim()),
          });
        } else {
          setResult({ ok: false, text: '连接失败：' + ((j && j.error) || '未知错误') });
        }
        STORE.refresh();
      }
      async function doSave() {
        const v = validate();
        if (v) { setResult({ ok: false, text: v }); return; }
        setBusy('save');
        const j = await postJSON('/dsh-backup-all/settings', payload());
        setBusy('');
        if (j && j.ok) {
          setForm(function (prev) { return Object.assign({}, prev, { apiKey: '' }); });
          setResult(null);
          setSavedFlash(true);
          if (savedTimer.current) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(function () { setSavedFlash(false); savedTimer.current = null; }, 2000);
          showToast('已保存');
          STORE.refresh();
        } else {
          setResult({ ok: false, text: '保存失败：' + ((j && j.error) || '未知错误') });
        }
      }

      const keyPlaceholder = ai.hasApiKey
        ? '已保存（' + (ai.apiKeyMasked || '') + '，留空则不修改）'
        : 'sk-…';

      return h('div', { className: 'dswba-form' },
        h(Field, { full: true, label: 'API Base URL' },
          h('input', {
            className: 'dswba-input', value: form.baseURL, placeholder: 'https://…/v1',
            onChange: function (e) { patch('baseURL', e.target.value); },
          })),
        h(Field, { label: 'API 协议' },
          h(SelectBox, {
            'aria-label': 'API 协议', value: form.protocol, options: PROTOCOL_OPTIONS,
            onChange: function (v) { patch('protocol', v); },
          })),
        h(Field, { label: 'API Key' },
          h('div', { className: 'dswba-row' },
            h('input', {
              className: 'dswba-input', type: showKey ? 'text' : 'password',
              value: form.apiKey, placeholder: keyPlaceholder,
              autoComplete: 'off', spellCheck: false,
              onChange: function (e) { patch('apiKey', e.target.value); },
            }),
            h('button', {
              type: 'button', className: 'dswba-eye', title: showKey ? '隐藏' : '显示',
              'aria-label': showKey ? '隐藏密钥' : '显示密钥',
              onClick: function () { setShowKey(!showKey); },
            }, h(showKey ? IconEyeOff : IconEye, { size: 15 })))),
        h(Field, { label: 'AI Model ID' },
          h('input', {
            className: 'dswba-input', value: form.modelId, placeholder: 'deepseek-v4.1-flash-1017',
            onChange: function (e) { patch('modelId', e.target.value); },
          })),
        h(Field, { label: '上下文窗口大小' },
          h('div', { className: 'dswba-row' },
            h('input', {
              className: 'dswba-input', value: form.contextWindowValue, inputMode: 'decimal',
              onChange: function (e) { patch('contextWindowValue', e.target.value); },
            }),
            h(SelectBox, {
              className: 'dswba-unit', 'aria-label': '上下文窗口单位',
              value: form.contextWindowUnit, options: UNIT_OPTIONS,
              onChange: function (v) { patch('contextWindowUnit', v); },
            }))),
        h(Field, { label: '最大输出大小' },
          h('div', { className: 'dswba-row' },
            h('input', {
              className: 'dswba-input', value: form.maxOutputValue, inputMode: 'decimal',
              onChange: function (e) { patch('maxOutputValue', e.target.value); },
            }),
            h(SelectBox, {
              className: 'dswba-unit', 'aria-label': '最大输出单位',
              value: form.maxOutputUnit, options: UNIT_OPTIONS,
              onChange: function (v) { patch('maxOutputUnit', v); },
            }))),
        h(Field, { label: 'Effort Level' },
          h(SelectBox, {
            'aria-label': 'Effort Level', value: form.effort, options: EFFORT_OPTIONS,
            onChange: function (v) { patch('effort', v); },
          })),
        h('div', { className: 'dswba-form-foot' },
          result
            ? h('span', { className: 'dswba-form-hint ' + (result.ok ? 'dswba-ok' : 'dswba-err') }, result.text)
            : savedFlash
              ? h('span', { className: 'dswba-form-hint dswba-ok' }, '已保存')
              : h('span', { className: 'dswba-form-hint' }, '密钥只保存在本插件 data/settings.json（0600）'),
          h(Btn, { onClick: doTest, disabled: busy !== '' }, busy === 'test' ? '测试中…' : '测试模型接通性'),
          h(Btn, { variant: 'primary', onClick: doSave, disabled: busy !== '' }, busy === 'save' ? '保存中…' : '保存')));
    }

    // ─────────────────────────────────────────────────────────────
    // 快照策略卡片：插件代码本体打包范围 + 是否不打包凭据。
    // 只提交 { snapshot: { packPluginCode, excludeCredentials } }，与 AI 配置互不影响。
    // ─────────────────────────────────────────────────────────────

    const SNAPSHOT_CODE_OPTIONS = [
      { value: 'local-only', label: '仅打包本地不可再下载插件（推荐）' },
      { value: 'all', label: '打包全部插件代码' },
      { value: 'none', label: '不打包插件代码' },
    ];
    const SNAPSHOT_CODE_HINTS = {
      'local-only': 'file:/link: 来源的本地插件代码会一并打包；registry/安装自带插件只记来源，恢复时重装。',
      'all': '全部已安装插件代码都打包（快照更大，可完全离线恢复）。',
      'none': '不打包任何插件代码（快照最小；本地插件恢复时可能缺代码，需自行备份）。',
    };
    // 跨 OS 恢复时插件代码策略（v1.3.0 可选增强）
    const CROSS_OS_CODE_OPTIONS = [
      { value: 'skip', label: '跳过（默认，安全）' },
      { value: 'js', label: '尝试迁移纯 JS 插件代码（实验性）' },
    ];
    const CROSS_OS_CODE_HINTS = {
      skip: '跨 OS 恢复时不写回任何插件代码（含原生二进制/符号链接的插件需在目标机重装）。',
      js: 'Host 逐个校验插件代码：纯 JS（无原生二进制、无平台限制）才写回；含 .node/.dll/.exe 等或 package.json os/cpu 不匹配的条目仍跳过并写警告。',
    };

    // Host 值 → 表单值（非法/缺失字段一律回落默认，与 Host publicSnapshotSettings 同规则）
    function buildSnapshotForm(src) {
      const s = src || {};
      return {
        packPluginCode: SNAPSHOT_CODE_HINTS[s.packPluginCode] ? s.packPluginCode : 'local-only',
        excludeCredentials: s.excludeCredentials === true,
        crossOsPluginCode: ['skip', 'js'].includes(s.crossOsPluginCode) ? s.crossOsPluginCode : 'skip',
      };
    }

    function SnapshotPolicyCard(props) {
      const snapshot = props.snapshot || {};
      const showToast = props.showToast || function () {};
      const [form, setForm] = useState(function () { return buildSnapshotForm(snapshot); });
      const [busy, setBusy] = useState(false);
      const [err, setErr] = useState('');
      const [savedFlash, setSavedFlash] = useState(false);
      const savedTimer = useRef(null);
      useEffect(function () {
        return function () { if (savedTimer.current) clearTimeout(savedTimer.current); };
      }, []);
      // Host 策略变化（保存后轮询回来 / 别处修改）时同步表单；
      // 依赖是原始值——轮询返回相同值不会重跑，不打断用户正在改但未保存的选择
      useEffect(function () {
        setForm(buildSnapshotForm(snapshot));
      }, [snapshot.packPluginCode, snapshot.excludeCredentials, snapshot.crossOsPluginCode]);

      function patch(next) {
        setForm(function (prev) { return Object.assign({}, prev, next); });
        setErr('');
      }
      async function doSave() {
        setBusy(true);
        setErr('');
        const j = await postJSON('/dsh-backup-all/settings', {
          snapshot: {
            packPluginCode: form.packPluginCode,
            excludeCredentials: form.excludeCredentials === true,
            crossOsPluginCode: form.crossOsPluginCode,
          },
        });
        setBusy(false);
        if (j && j.ok) {
          setSavedFlash(true);
          if (savedTimer.current) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(function () { setSavedFlash(false); savedTimer.current = null; }, 2000);
          showToast('已保存');
          STORE.refresh();
        } else {
          setErr('保存失败：' + ((j && j.error) || '未知错误'));
        }
      }

      const exclude = form.excludeCredentials === true;
      return h('div', { className: 'dswba-snap' },
        h('div', { className: 'dswba-snap-head' },
          h('div', { className: 'dswba-snap-title' }, '快照策略'),
          h('div', { className: 'dswba-snap-sub' }, '决定快照里是否带插件代码本体 / 凭据')),
        // 字段式布局与 AI 配置表单一致：label 小字在上 → 控件 → 动态提示小字在下
        h('div', { className: 'dswba-snap-row' },
          h('label', { className: 'dswba-label', htmlFor: 'dswba-snap-code' }, '插件代码本体'),
          h(SelectBox, {
            id: 'dswba-snap-code', className: 'dswba-snap-dd', 'aria-label': '插件代码本体',
            value: form.packPluginCode, disabled: busy, options: SNAPSHOT_CODE_OPTIONS,
            onChange: function (v) { patch({ packPluginCode: v }); },
          }),
          h('div', { className: 'dswba-snap-hint' },
            SNAPSHOT_CODE_HINTS[form.packPluginCode] || SNAPSHOT_CODE_HINTS['local-only'])),
        h('div', { className: 'dswba-snap-row' },
          h('span', { className: 'dswba-label' }, '不打包凭据'),
          h('button', {
            type: 'button', role: 'switch', className: 'dswba-switch',
            'aria-checked': exclude, 'aria-label': '不打包凭据', disabled: busy,
            title: exclude ? '已开启：凭据不入包' : '已关闭：凭据原样入包',
            onClick: function () { patch({ excludeCredentials: !exclude }); },
          }, h('span', { className: 'dswba-switch-knob' })),
          h('div', { className: 'dswba-snap-hint' + (exclude ? ' warn' : '') },
            exclude
              ? '不打包 .credentials.yaml，恢复后需重新填写 API Key / 账号凭据'
              : '凭据文件会原样入包（明文），恢复后请轮换密钥')),
        h('div', { className: 'dswba-snap-row' },
          h('label', { className: 'dswba-label', htmlFor: 'dswba-snap-cross-os-code' }, '跨 OS 恢复插件代码'),
          h(SelectBox, {
            id: 'dswba-snap-cross-os-code', className: 'dswba-snap-dd', 'aria-label': '跨 OS 恢复插件代码',
            value: form.crossOsPluginCode, disabled: busy, options: CROSS_OS_CODE_OPTIONS,
            onChange: function (v) { patch({ crossOsPluginCode: v }); },
          }),
          h('div', { className: 'dswba-snap-hint' },
            CROSS_OS_CODE_HINTS[form.crossOsPluginCode] || CROSS_OS_CODE_HINTS.skip)),
        h('div', { className: 'dswba-snap-foot' },
          err
            ? h('span', { className: 'dswba-form-hint dswba-err' }, err)
            : savedFlash
              ? h('span', { className: 'dswba-form-hint dswba-ok' }, '已保存')
              : null,
          h(Btn, { variant: 'primary', onClick: doSave, disabled: busy }, busy ? '保存中…' : '保存')));
    }

    function AdvancedPage(props) {
      const state = props.state || null;
      const aiOpen = Boolean(props.aiOpen);
      const setAiOpen = props.setAiOpen || function () {};
      const showToast = props.showToast || function () {};
      const ai = (state && state.settings && state.settings.ai) || {};
      const totalCount = props.totalCount || 0;
      const [clearOpen, setClearOpen] = useState(false);
      const [clearBusy, setClearBusy] = useState(false);
      const configured = Boolean(ai.configured);
      const led = ai.connected === true ? 'ok' : ai.connected === false ? 'bad' : '';
      const dotTitle = ai.connected === true ? '连接正常' : ai.connected === false ? '连接失败' : '未测试';

      async function doClear() {
        setClearBusy(true);
        const j = await postJSON('/dsh-backup-all/clear', { confirm: true });
        setClearBusy(false);
        if (j && j.ok) {
          setClearOpen(false);
          showToast('已清除 ' + (j.removed != null ? j.removed : totalCount) + ' 个快照');
        } else {
          showToast('清除失败：' + ((j && j.error) || '未知错误'));
        }
        STORE.refresh();
      }

      return h('div', { className: 'dswba-adv' },
        h('button', {
          type: 'button', className: 'dswba-ai-btn', 'aria-expanded': aiOpen,
          onClick: function () { setAiOpen(!aiOpen); },
        },
        h('span', { className: 'dswba-ai-btn-main' },
          h('span', { className: 'dswba-ai-btn-title' }, 'AI 配置'),
          h('span', { className: 'dswba-ai-btn-sub' }, '用于创建快照与恢复的独立模型')),
        h('span', { className: 'dswba-ai-status' },
          configured ? h('span', { className: 'dswba-led ' + led, title: dotTitle }) : null,
          h('span', { className: 'dswba-ai-model' }, configured ? (ai.modelId || '已配置') : '未配置'),
          h(IconChevron, { size: 16, style: { transform: aiOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' } }))),
        aiOpen ? h(AiConfigForm, { ai: ai, showToast: showToast }) : null,
        h(SnapshotPolicyCard, {
          snapshot: (state && state.settings && state.settings.snapshot) || {},
          showToast: showToast,
        }),
        h('button', { type: 'button', className: 'dswba-clearbtn', onClick: function () { setClearOpen(true); } },
          h('span', { className: 'dswba-clearbtn-t' }, h(IconTrash, { size: 15 }), '清除所有快照'),
          h('span', { className: 'dswba-clearbtn-s' }, '删除全部压缩包与记录，不可恢复')),
        clearOpen
          ? h(ConfirmDialog, {
            title: '清除所有快照？',
            body: '将删除 ' + totalCount + ' 个快照及其压缩包文件，此操作不可恢复。',
            confirmText: '确认清除', danger: true, busy: clearBusy,
            onConfirm: doClear,
            onCancel: function () { setClearOpen(false); },
          })
          : null);
    }

    // ─────────────────────────────────────────────────────────────
    // 设置页主体（settings.section）
    // ─────────────────────────────────────────────────────────────

    function BackupAllSection() {
      const { state, error } = useStore();
      const [tab, setTab] = useState('snapshots');      // 'snapshots' | 'advanced'
      const [archivedView, setArchivedView] = useState(false);
      const [aiOpen, setAiOpen] = useState(false);
      const [createOpen, setCreateOpen] = useState(false);
      // runWindow: {mode:'create'|'restore'|'watch', kind, title, runId, record?, payload?}
      const [runWindow, setRunWindow] = useState(null);
      const [editTarget, setEditTarget] = useState(null);
      const [promoteTarget, setPromoteTarget] = useState(null);
      const [toast, setToast] = useState('');
      const toastTimer = useRef(null);
      useEffect(function () {
        return function () { if (toastTimer.current) clearTimeout(toastTimer.current); };
      }, []);
      const showToast = useCallback(function (text) {
        setToast(String(text || ''));
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(function () { setToast(''); toastTimer.current = null; }, 2600);
      }, []);

      const ai = (state && state.settings && state.settings.ai) || {};
      const version = (state && state.version) || '';
      const totalBytes = (state && state.totalBytes) || 0;
      // 兼容两种 Host 形态：records+archived 两个数组（当前 Host），或单数组带 archived 标志（API-CONTRACT）
      const rawRecords = (state && Array.isArray(state.records)) ? state.records : [];
      const activeRecords = useMemo(function () {
        return rawRecords.filter(function (r) { return r && !r.archived; });
      }, [state]);
      const archivedRecords = useMemo(function () {
        if (state && Array.isArray(state.archived)) {
          return state.archived.filter(function (r) { return Boolean(r); })
            .concat(rawRecords.filter(function (r) { return r && r.archived; }));
        }
        return rawRecords.filter(function (r) { return r && r.archived; });
      }, [state]);
      const totalCount = activeRecords.length + archivedRecords.length;
      const run = state ? state.run : null;
      const runActive = Boolean(run && run.status === 'running');

      function openWatch() {
        if (!run) return;
        setRunWindow({
          mode: 'watch', watch: true, kind: run.kind === 'restore' ? 'restore' : 'snapshot',
          title: run.snapshotName || '', runId: run.id,
        });
      }

      // ── 内容区：加载态 / 错误态 / 三个页面 ──
      let page = null;
      if (!state) {
        page = error
          ? h('div', { className: 'dswba-empty' },
            h(IconAlert, { size: 36, style: { color: 'var(--dsw-alias-state-error-primary)' } }),
            h('div', { className: 'dswba-empty-title' }, '无法加载 Backup ALL 状态'),
            h('div', { className: 'dswba-empty-sub' }, String(error)),
            h('div', { style: { marginTop: 6 } },
              h(Btn, { onClick: function () { STORE.refresh(); } }, '重试')))
          : h('div', { className: 'dswba-empty' },
            h(Spinner, { size: 22 }),
            h('div', { className: 'dswba-empty-sub', style: { marginTop: 6 } }, '正在加载 Backup ALL…'));
      } else {
        page = h(React.Fragment, null,
          h('div', { className: 'dswba-head' },
            h('div', { className: 'dswba-title' },
              'Backup ALL',
              h('span', { className: 'dswba-ver' }, 'v' + (version || '1.0.0'))),
            h('div', { className: 'dswba-head-right' },
              h('div', null, '快照文件已占用 ', h('b', null, formatSize(totalBytes))),
              h('div', { className: 'dswba-head-count' }, '共 ' + totalCount + ' 个快照' +
                (archivedRecords.length ? '（' + archivedRecords.length + ' 个已归档）' : '')))),
          h('div', { className: 'dswba-nav' },
            h('button', {
              type: 'button', className: 'dswba-nav-item' + (tab === 'snapshots' ? ' on' : ''),
              onClick: function () { setTab('snapshots'); },
            }, '快照列表'),
            h('button', {
              type: 'button', className: 'dswba-nav-item' + (tab === 'advanced' ? ' on' : ''),
              onClick: function () { setTab('advanced'); },
            }, '高级设置')),
          tab === 'advanced'
            ? h(AdvancedPage, { state: state, aiOpen: aiOpen, setAiOpen: setAiOpen, showToast: showToast, totalCount: totalCount })
            : archivedView
              ? h(ArchivedPage, {
                records: archivedRecords, showToast: showToast,
                onBack: function () { setArchivedView(false); },
              })
              : h(SnapshotsPage, {
                records: activeRecords, archivedCount: archivedRecords.length,
                run: run, runActive: runActive, showToast: showToast,
                onOpenCreate: function () { setCreateOpen(true); },
                onOpenArchived: function () { setArchivedView(true); },
                onEdit: function (record) { setEditTarget(record); },
                onPromote: function (record) { setPromoteTarget(record); },
                onRestore: function (record) {
                  setRunWindow({ mode: 'restore', kind: 'restore', title: record.name || '', record: record });
                },
                onWatch: openWatch,
              }));
      }

      // ── 运行窗口（创建第 2 步 / 恢复 / 观察）──
      let runStartFn = null;
      if (runWindow) {
        if (runWindow.mode === 'create') {
          const payload = runWindow.payload || {};
          runStartFn = function () {
            return postJSON('/dsh-backup-all/snapshot/create', {
              name: payload.name || defaultSnapshotName(),
              description: payload.description || '',
            });
          };
        } else if (runWindow.mode === 'restore') {
          const record = runWindow.record || {};
          runStartFn = function () {
            return postJSON('/dsh-backup-all/restore/start', { id: record.id || '' });
          };
        }
      }
      const runModal = runWindow
        ? h(RunWindow, {
          modal: true,
          watch: Boolean(runWindow.watch),
          kind: runWindow.kind,
          titleName: runWindow.title || '',
          initialRunId: runWindow.runId || null,
          startFn: runStartFn,
          onClose: function () { setRunWindow(null); STORE.refresh(); },
        })
        : null;

      return h(React.Fragment, null,
        h(Style),
        h('div', { className: 'dswba-root' }, page),
        // 创建流程第 1 步
        createOpen
          ? h(CreateDialog, {
            aiConfigured: Boolean(ai.configured),
            canClose: !runActive,
            onClose: function () { setCreateOpen(false); },
            onNext: function (payload) {
              setCreateOpen(false);
              setRunWindow({ mode: 'create', kind: 'snapshot', title: payload.name, payload: payload });
            },
            onGoAdvanced: function () {
              setCreateOpen(false);
              setTab('advanced');
              setAiOpen(true);
            },
          })
          : null,
        runModal,
        // 编辑快照
        editTarget
          ? h(NameDescDialog, {
            title: '编辑快照', confirmText: '保存',
            initialName: editTarget.name || '', initialDesc: editTarget.description || '',
            onClose: function () { setEditTarget(null); },
            onSubmit: async function (p) {
              const j = await postJSON('/dsh-backup-all/snapshot/edit', {
                id: editTarget.id, name: p.name, description: p.description,
              });
              if (j && j.ok) { showToast('已保存'); STORE.refresh(); }
              return j;
            },
          })
          : null,
        // 恢复前快照 → 永久快照
        promoteTarget
          ? h(NameDescDialog, {
            title: '保存为永久快照', confirmText: '保存',
            note: '恢复前快照会被下一次恢复流程替换；保存为永久快照后会作为普通快照长期保留。',
            initialName: promoteTarget.name === '恢复前快照' ? defaultSnapshotName() : (promoteTarget.name || ''),
            initialDesc: promoteTarget.description || '',
            onClose: function () { setPromoteTarget(null); },
            onSubmit: async function (p) {
              const j = await postJSON('/dsh-backup-all/snapshot/promote', {
                id: promoteTarget.id, name: p.name, description: p.description,
              });
              if (j && j.ok) { showToast('已保存为永久快照'); STORE.refresh(); }
              return j;
            },
          })
          : null,
        toast ? h('div', { className: 'dswba-toast', role: 'status' }, toast) : null);
    }

    // ─────────────────────────────────────────────────────────────
    // 悬浮球 + 快照进程窗口（shell.overlay）
    //   仅在 run 运行中显示；终态（完成/中断/失败）后停留 3 秒消失；
    //   点击打开进程窗口（输出 + 同款多功能按钮），完成后窗口内出「关闭」。
    //   根元素点击穿透（overlay 层要求），球和面板各自 pointerEvents:auto。
    // ─────────────────────────────────────────────────────────────

    function FloatingBall() {
      const { state } = useStore();
      const run = (state && state.run) || null;
      const runId = (run && run.id) || null;
      const runStatus = (run && run.status) || null;
      const [panel, setPanel] = useState(null); // {id, kind, name}
      const [linger, setLinger] = useState(false);
      const prev = useRef({ id: null, status: null });
      const hideTimer = useRef(null);
      useEffect(function () {
        return function () { if (hideTimer.current) clearTimeout(hideTimer.current); };
      }, []);
      // running → 终态：球停留 3 秒再消失
      useEffect(function () {
        const was = prev.current;
        prev.current = { id: runId, status: runStatus };
        if (runId && runId === was.id && was.status === 'running' && runStatus && runStatus !== 'running') {
          setLinger(true);
          if (hideTimer.current) clearTimeout(hideTimer.current);
          hideTimer.current = setTimeout(function () { setLinger(false); hideTimer.current = null; }, 3000);
        }
      }, [runId, runStatus]);

      const running = runStatus === 'running';
      const visible = Boolean(run) && (running || linger);
      const pct = Math.max(0, Math.min(100, Math.round((run && run.progress) || 0)));
      const R = 20;
      const C = 2 * Math.PI * R;
      const ringCls = 'dswba-ball-fill' +
        (run && !running && run.status === 'done' ? ' done' : '') +
        (run && !running && (run.status === 'interrupted' || run.status === 'failed') ? ' bad' : '');

      function openPanel() {
        if (!run) return;
        setPanel({ id: run.id, kind: run.kind, name: run.snapshotName || '' });
      }

      return h('div', { className: 'dswba-float-root' },
        h(Style),
        visible
          ? h('button', {
            type: 'button', className: 'dswba-ball', onClick: openPanel,
            'aria-label': '快照进程',
            title: ((run && run.kind) === 'restore' ? '恢复快照' : '创建快照') +
              '：' + ((run && run.snapshotName) || '') + ' · ' + pct + '%（点击查看进程）',
          },
          h('svg', { viewBox: '0 0 48 48', 'aria-hidden': true, style: { transform: 'rotate(-90deg)' } },
            h('circle', { className: 'dswba-ball-ring', cx: 24, cy: 24, r: R }),
            h('circle', {
              className: ringCls, cx: 24, cy: 24, r: R,
              strokeDasharray: String(C),
              strokeDashoffset: String(C * (1 - pct / 100)),
            })),
          h('span', { className: 'dswba-ball-txt' }, pct + '%'))
          : null,
        panel
          ? h('div', { className: 'dswba-panel', role: 'dialog', 'aria-label': '快照进程窗口' },
            h(RunWindow, {
              modal: false, watch: true, kind: panel.kind, titleName: panel.name,
              initialRunId: panel.id, startFn: null,
              onClose: function () { setPanel(null); },
            }))
          : null);
    }

    // ─────────────────────────────────────────────────────────────
    // 注册（形状按 DSH 客户端 bundle 硬约束，勿改）
    // ─────────────────────────────────────────────────────────────

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'backup-all', order: 25, label: 'Backup ALL',
        }, BackupAllSection));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'backup-all-floating', order: 60,
        }, FloatingBall));
      },
    };
  },
});
