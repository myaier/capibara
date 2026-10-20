// The plaza's look and motion: CSS keyframes run on the compositor, so a full office stays cheap.
// Web only. Every rule is scoped under .plz and every keyframe is plz- prefixed, so nothing leaks into the host page.
const CSS = `
.plz .plz-world{position:relative}
.plz .plz-backdrop{position:absolute;left:0;top:0;z-index:0;pointer-events:none;overflow:visible}
.plz .plz-piece{position:absolute;overflow:visible;pointer-events:none}
.plz .plz-actor{position:absolute;width:0;height:0;pointer-events:none}
.plz .capy{position:absolute;left:0;top:0;width:0;height:0;will-change:transform}
.plz .capy-breath{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;animation:plz-capy-breathe 3.6s ease-in-out infinite}
.plz .capy canvas{position:absolute;display:block}
@keyframes plz-capy-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.007,1.016)}}
.plz .plz-actor.is-offline,.plz .plz-piece.is-offline{filter:grayscale(1);opacity:.55}
.plz .plz-station{position:absolute;border:0;padding:0;margin:0;background:transparent!important;border-radius:14px;cursor:pointer;display:block;min-height:0;outline:none}
.plz .plz-station:disabled{cursor:default;opacity:1}
.plz .plz-plate{position:absolute;left:7px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;line-height:1.2;white-space:nowrap;pointer-events:none}
.plz .plz-plate strong{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:#4a423b;letter-spacing:.3px;padding:2px 9px;border-radius:9px;transition:background .18s,color .18s}
.plz .plz-plate strong i{width:6px;height:6px;border-radius:50%;background:var(--tone,#b9b1a7);display:inline-block;flex:none}
.plz .plz-plate small{font-size:10.5px;color:#a0968c;letter-spacing:.2px}
.plz .plz-station:hover .plz-plate strong{background:#efe9e1}
.plz .plz-station.selected .plz-plate strong{background:#2f2a26;color:#fff}
.plz .plz-station:focus-visible .plz-plate strong{outline:2px solid #8fb3ff;outline-offset:2px}
.plz .plz-station.offline .plz-plate{opacity:.7}
.plz .plz-bubble{position:absolute;width:30px;height:30px;border-radius:15px;background:#fff;box-shadow:0 2px 10px rgba(84,62,40,.13),0 0 0 1px rgba(84,62,40,.06);display:flex;align-items:center;justify-content:center;color:var(--tone);animation:plz-bubble-float 2.8s ease-in-out infinite;pointer-events:none}
.plz .plz-bubble:after{content:"";position:absolute;left:6px;bottom:-3px;width:9px;height:9px;background:#fff;transform:rotate(45deg);border-radius:2px}
.plz .plz-bubble svg{position:relative;z-index:1}
@keyframes plz-bubble-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.plz .plz-sign{position:absolute;z-index:2;font-size:15px;font-weight:600;color:#6a6159;letter-spacing:.3px;white-space:nowrap}
.plz .plz-sign small{font-size:12px;font-weight:400;color:#aba196;margin-left:10px}
.plz .is-floor .plz-plate strong{font-size:min(calc(12px / var(--world-scale,1)),22px);padding:1px 7px}
.plz .is-floor .plz-plate small{display:none}
.plz .is-floor .plz-plate strong i{width:min(calc(6px / var(--world-scale,1)),11px);height:min(calc(6px / var(--world-scale,1)),11px)}
.plz .is-floor .plz-bubble{transform-origin:15px 30px;scale:min(calc(.7 / var(--world-scale,1)),1.6)}
.plz .is-floor .plz-sign{font-size:calc(13px / var(--world-scale,1))}
.plz .is-floor .plz-sign small{font-size:calc(10px / var(--world-scale,1))}
@media (prefers-reduced-motion:reduce){.plz .capy-breath,.plz .plz-bubble{animation:none}}
.plz .capy-act,.plz .capy-walk{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}
.plz .capy-shadow{position:absolute;border-radius:50%;background:radial-gradient(closest-side,rgba(70,58,46,.24),rgba(70,58,46,0));opacity:0;transition:opacity .25s}
.plz .capy[data-standing="true"] .capy-shadow{opacity:1}
.plz .capy-fx{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}
.plz .capy-act[data-act="running"]{animation:plz-act-type .34s ease-in-out infinite}
@keyframes plz-act-type{0%,100%{transform:translateY(0) rotate(.8deg)}50%{transform:translateY(-1.4px) rotate(.8deg)}}
.plz .capy-act[data-act="starting"]{animation:plz-act-boot 1.8s ease-in-out infinite}
@keyframes plz-act-boot{0%,100%{transform:translate(1px,0) rotate(2deg)}50%{transform:translate(2px,-2px) rotate(3.2deg)}}
.plz .capy-act[data-act="approval"]{animation:plz-act-stand 2.6s ease-in-out infinite}
@keyframes plz-act-stand{0%{transform:translateY(-13px) rotate(0)}10%{transform:translateY(-19px) rotate(-3deg)}22%{transform:translateY(-13px) rotate(2.6deg)}34%{transform:translateY(-16px) rotate(-2deg)}46%,100%{transform:translateY(-13px) rotate(0)}}
.plz .capy-act[data-act="question"]{animation:plz-act-tilt 3.4s ease-in-out infinite}
@keyframes plz-act-tilt{0%,100%{transform:rotate(-6deg)}50%{transform:rotate(4deg)}}
.plz .capy-act[data-act="plan"]{animation:plz-act-present 1.9s ease-in-out infinite}
@keyframes plz-act-present{0%,100%{transform:translateY(-5px) scale(1.02)}40%{transform:translateY(-9px) scale(1.035)}60%{transform:translateY(-5px) scale(1.02)}}
.plz .capy-act[data-act="error"]{animation:plz-act-shake 3.2s linear infinite}
@keyframes plz-act-shake{0%{transform:translate(0,-5px)}2%{transform:translate(-3px,-6px)}4%{transform:translate(3px,-5px)}6%{transform:translate(-3px,-6px)}8%{transform:translate(3px,-5px)}10%{transform:translate(-2px,-5px)}12%{transform:translate(1px,-4px)}14%,100%{transform:translate(0,-3px)}}
.plz .capy-act[data-act="quota"]{animation:plz-act-slump 4.6s ease-in-out infinite}
@keyframes plz-act-slump{0%,100%{transform:translateY(9px) rotate(-2.4deg) scale(1,.985)}50%{transform:translateY(7px) rotate(-1deg) scale(1,1.012)}}
.plz .capy-act[data-act="silent"]{animation:plz-act-sway 4.2s ease-in-out infinite}
@keyframes plz-act-sway{0%,100%{transform:rotate(-2.6deg)}50%{transform:rotate(2.6deg)}}
.plz .capy-act[data-act="unfinished"]{animation:plz-act-dizzy 1.9s ease-in-out infinite}
@keyframes plz-act-dizzy{0%,100%{transform:translateX(-2px) rotate(-4.5deg)}25%{transform:translateX(0) rotate(0)}50%{transform:translateX(2px) rotate(4.5deg)}75%{transform:translateX(0) rotate(0)}}
.plz .capy-act[data-act="unread"]{animation:plz-act-offer 1.5s cubic-bezier(.3,0,.3,1) infinite}
@keyframes plz-act-offer{0%,100%{transform:translateY(-7px)}28%{transform:translateY(-12px) rotate(-1.6deg)}55%{transform:translateY(-7px)}}
.plz .capy-act[data-act="idle"]{animation:plz-act-wait 2.4s ease-in-out infinite}
@keyframes plz-act-wait{0%,40%,100%{transform:rotate(-3deg) translateY(0)}20%{transform:rotate(-3deg) translateY(-2.5px)}}
.plz .capy-act[data-act="done"]{animation:plz-act-stretch 1s ease-out 1,plz-act-content 4.4s ease-in-out 1s infinite}
@keyframes plz-act-stretch{0%{transform:scale(1,1)}35%{transform:translateY(-6px) scale(.97,1.06)}70%{transform:translateY(0) scale(1.02,.98)}100%{transform:scale(1,1)}}
@keyframes plz-act-content{0%,100%{transform:rotate(-1.2deg)}50%{transform:rotate(1.6deg) translateY(-1px)}}
.plz .capy-act[data-act="snoozed"]{animation:plz-act-nod 5s ease-in-out infinite}
@keyframes plz-act-nod{0%,100%{transform:translateY(3px) rotate(0)}50%{transform:translateY(4px) rotate(3.5deg)}}
.plz .capy-act[data-act="quiet"]{animation:plz-act-lean 6s ease-in-out infinite}
@keyframes plz-act-lean{0%,100%{transform:rotate(-3.2deg)}50%{transform:rotate(-1deg)}}
.plz .capy-act[data-act="closed"]{transform:scaleX(-1) translateY(2px)}
.plz .capy-act[data-act="canceled"]{transform:translateY(6px) rotate(-1.6deg)}
.plz .fx{position:absolute;display:block;pointer-events:none;line-height:1}
.plz .fx-q{color:#8b6cf0;font-weight:800;font-family:"Arial Rounded MT Bold",Arial,sans-serif;text-shadow:0 0 3px #fff,0 0 2px #fff;opacity:0;animation:plz-fx-rise 2.85s ease-out infinite}
@keyframes plz-fx-rise{0%{opacity:0;transform:translate(0,4px) scale(.7)}18%{opacity:1;transform:translate(2px,-6px) scale(1)}70%{opacity:.9}100%{opacity:0;transform:translate(10px,-32px) scale(.9)}}
.plz .fx-notice{transform-origin:80% 80%;animation:plz-fx-notice 1.3s ease-in-out infinite}
@keyframes plz-fx-notice{0%,100%{opacity:.3;transform:scale(.82)}50%{opacity:1;transform:scale(1.06)}}
.plz .fx-doc{filter:drop-shadow(0 2px 4px rgba(84,62,40,.16));animation:plz-fx-bob 2.4s ease-in-out infinite}
@keyframes plz-fx-bob{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-4px) rotate(2deg)}}
.plz .fx-doc-check{transform-box:fill-box;transform-origin:center;animation:plz-fx-check 2.4s ease-in-out infinite}
@keyframes plz-fx-check{0%,30%{transform:scale(0)}42%{transform:scale(1.3)}52%,88%{transform:scale(1)}100%{transform:scale(0)}}
.plz .fx-bang{color:#f0524f;font-weight:900;font-family:"Arial Black",Arial,sans-serif;text-shadow:0 0 3px #fff,0 0 2px #fff;transform-origin:50% 90%;animation:plz-fx-bang 3.2s ease-out infinite}
@keyframes plz-fx-bang{0%{transform:scale(0);opacity:0}5%{transform:scale(1.4);opacity:1}10%{transform:scale(.88)}14%{transform:scale(1.06)}18%,100%{transform:scale(1);opacity:1}}
.plz .fx-sweat{background:#9fd0ef;border-radius:0 50% 50% 50%;opacity:0;animation:plz-fx-sweat 2.4s ease-in infinite}
@keyframes plz-fx-sweat{0%{opacity:0;transform:translateY(-4px) rotate(45deg) scale(.6)}20%{opacity:1;transform:translateY(0) rotate(45deg) scale(1)}80%{opacity:1}100%{opacity:0;transform:translateY(15px) rotate(45deg) scale(.9)}}
.plz .fx-sigh{opacity:0;transform-origin:0 50%;animation:plz-fx-sigh 4.6s ease-out infinite}
@keyframes plz-fx-sigh{0%,48%{opacity:0;transform:translate(0,0) scale(.35)}58%{opacity:1;transform:translate(4px,-2px) scale(.9)}85%{opacity:.7;transform:translate(15px,-6px) scale(1.1)}100%{opacity:0;transform:translate(22px,-9px) scale(1.2)}}
.plz .fx-orbit{width:0;height:0}
.plz .fx-orbit-star{position:absolute;left:0;top:0;offset-rotate:0deg;animation:plz-fx-orbit 1.85s linear infinite}
@keyframes plz-fx-orbit{from{offset-distance:0%}to{offset-distance:100%}}
.plz .fx-twinkle{opacity:0;transform-origin:center;animation:plz-fx-twinkle 1.8s ease-in-out infinite}
.plz .fx-twinkle.slow{animation-duration:3.4s}
@keyframes plz-fx-twinkle{0%,100%{opacity:0;transform:scale(.3) rotate(0)}45%{opacity:1;transform:scale(1.15) rotate(45deg)}70%{opacity:.8;transform:scale(.9) rotate(60deg)}}
.plz .fx-typing{display:flex;gap:3px;padding:7px 8px;background:#fff;border-radius:12px;box-shadow:0 2px 9px rgba(84,62,40,.14),0 0 0 1px rgba(84,62,40,.05);transform-origin:0 100%}
.plz .fx-typing:after{content:"";position:absolute;left:5px;bottom:-3px;width:8px;height:8px;background:#fff;transform:rotate(45deg);border-radius:2px}
.plz .fx-typing i{position:relative;z-index:1;width:5px;height:5px;border-radius:50%;background:#a78bfa;animation:plz-fx-dot 1.2s ease-in-out infinite}
.plz .fx-typing i:nth-child(2){animation-delay:.16s}
.plz .fx-typing i:nth-child(3){animation-delay:.32s}
@keyframes plz-fx-dot{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-3px);opacity:1}}
.plz .fx-done{opacity:0;filter:drop-shadow(0 2px 4px rgba(52,211,153,.35));animation:plz-fx-done 7s ease-out infinite}
@keyframes plz-fx-done{0%{opacity:0;transform:translateY(8px) scale(.4)}6%{opacity:1;transform:translateY(-4px) scale(1.18)}10%{transform:translateY(-6px) scale(1)}28%{opacity:1;transform:translateY(-12px)}38%,100%{opacity:0;transform:translateY(-18px)}}
.plz .fx-snooze{display:flex;align-items:flex-start;gap:1px;transform-origin:0 100%;animation:plz-fx-bob 3.6s ease-in-out infinite}
.plz .fx-snooze b{font:700 11px Arial,sans-serif;color:#818cf8;animation:plz-fx-z 3.6s ease-out infinite}
@keyframes plz-fx-z{0%{opacity:0;transform:translate(0,2px)}30%{opacity:1}100%{opacity:0;transform:translate(6px,-11px)}}
.plz .fx-steam{width:0;height:0;transform-origin:0 100%}
.plz .fx-steam i{position:absolute;bottom:0;width:6px;height:15px;border-left:2px solid rgba(160,150,140,.5);border-radius:50%;opacity:0;animation:plz-fx-steam 2.6s ease-out infinite}
.plz .fx-steam i:nth-child(2){left:6px;animation-delay:1.2s}
@keyframes plz-fx-steam{0%{opacity:0;transform:translateY(4px) scaleY(.6)}30%{opacity:1}100%{opacity:0;transform:translateY(-12px) scaleY(1.1)}}
.plz .fx-cross{color:#b5afa7;font-weight:300;font-family:Arial,sans-serif;opacity:0;animation:plz-fx-fade 4.4s ease-in-out infinite}
@keyframes plz-fx-fade{0%,100%{opacity:0;transform:scale(.8)}30%,70%{opacity:.9;transform:scale(1)}}
.plz .plz-deskfx{position:absolute;width:0;height:0;pointer-events:none}
.plz .fx-key{font:600 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#5b8fd9;white-space:nowrap;opacity:0;animation:plz-fx-key 2.2s ease-out infinite}
@keyframes plz-fx-key{0%{opacity:0;transform:translateY(2px) scale(.8)}15%{opacity:.9;transform:translateY(-6px) scale(1)}100%{opacity:0;transform:translateY(-36px) scale(.95)}}
.plz .fx-spinner{width:17px;height:17px;border-radius:50%;border:2.5px solid rgba(56,189,248,.22);border-top-color:#38bdf8;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.08);animation:plz-fx-spin .85s linear infinite}
@keyframes plz-fx-spin{to{transform:rotate(360deg)}}
.plz .fx-smoke{width:0;height:0}
.plz .fx-smoke i{position:absolute;left:0;top:0;width:12px;height:12px;border-radius:50%;background:rgba(150,146,141,.5);opacity:0;animation:plz-fx-smoke 3.2s ease-out infinite}
.plz .fx-smoke i:nth-child(2){left:7px;animation-delay:.55s}
@keyframes plz-fx-smoke{0%{opacity:0;transform:translate(0,0) scale(.4)}20%{opacity:.8}100%{opacity:0;transform:translate(9px,-28px) scale(1.9)}}
.plz .fx-battery{width:22px;height:12px;border:2px solid #fb923c;border-radius:3px;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.08);animation:plz-fx-blink 1.5s ease-in-out infinite}
.plz .fx-battery:after{content:"";position:absolute;right:-5px;top:2px;width:3px;height:4px;border-radius:1px;background:#fb923c}
.plz .fx-battery i{position:absolute;left:2px;top:2px;width:4px;height:4px;background:#fb923c;border-radius:1px}
@keyframes plz-fx-blink{0%,100%{opacity:1}50%{opacity:.3}}
.plz .screen-glow{opacity:.5}
.plz .screen-glow[data-phase="running"]{animation:plz-glow-flicker 2.6s steps(1) infinite}
@keyframes plz-glow-flicker{0%{opacity:.55}12%{opacity:.72}20%{opacity:.5}37%{opacity:.74}52%{opacity:.58}68%{opacity:.76}83%{opacity:.52}}
.plz .screen-glow[data-phase="starting"]{animation:plz-glow-boot 3.2s ease-in-out infinite}
@keyframes plz-glow-boot{0%{opacity:0}30%{opacity:.85}45%{opacity:.4}100%{opacity:.65}}
.plz .screen-glow[data-phase="approval"],.plz .screen-glow[data-phase="question"],.plz .screen-glow[data-phase="plan"],.plz .screen-glow[data-phase="unread"],.plz .screen-glow[data-phase="idle"]{animation:plz-glow-pulse 1.6s ease-in-out infinite}
@keyframes plz-glow-pulse{0%,100%{opacity:.28}50%{opacity:.88}}
.plz .screen-glow[data-phase="error"]{animation:plz-glow-alarm .9s ease-in-out infinite}
@keyframes plz-glow-alarm{0%,100%{opacity:.95}50%{opacity:.2}}
.plz .screen-glow[data-phase="quota"]{animation:plz-glow-pulse 3.4s ease-in-out infinite}
.plz .screen-glow[data-phase="silent"],.plz .screen-glow[data-phase="unfinished"],.plz .screen-glow[data-phase="snoozed"]{opacity:.3}
.plz .screen-edge[data-phase="error"]{animation:plz-glow-alarm .9s ease-in-out infinite}
.plz .plz-plate i[data-pulse="attention"]{animation:plz-led-pulse 1.4s ease-out infinite}
@keyframes plz-led-pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--tone) 70%,transparent)}100%{box-shadow:0 0 0 6px color-mix(in srgb,var(--tone) 0%,transparent)}}
.plz .plz-plate i[data-pulse="busy"]{animation:plz-led-busy 2.4s ease-in-out infinite}
@keyframes plz-led-busy{0%,100%{opacity:1}50%{opacity:.4}}
.plz .plz-bubble.ripple:before{content:"";position:absolute;inset:0;border-radius:50%;border:2px solid var(--tone);animation:plz-ripple 1.8s ease-out infinite}
@keyframes plz-ripple{0%{transform:scale(1);opacity:.65}100%{transform:scale(1.95);opacity:0}}
@keyframes plz-cloud-drift{from{transform:translateX(-24px)}to{transform:translateX(28px)}}
@keyframes plz-sway{0%,100%{transform:rotate(-1.4deg)}50%{transform:rotate(1.7deg)}}
@keyframes plz-clock{to{transform:rotate(360deg)}}
.plz .desk-steam path{fill:none;stroke:rgba(160,150,140,.45);stroke-width:1.3;stroke-linecap:round;opacity:0;animation:plz-steam 2.8s ease-out infinite}
.plz .desk-steam path:nth-child(2){animation-delay:1.2s}
@keyframes plz-steam{0%{opacity:0;transform:translateY(3px)}30%{opacity:1}100%{opacity:0;transform:translateY(-8px)}}
@keyframes plz-daylight{0%,100%{opacity:.62}50%{opacity:.84}}
.plz .fx-cricket{color:#aaa49b;font-family:Arial,sans-serif;opacity:0;animation:plz-fx-cricket 2.8s ease-in-out infinite}
@keyframes plz-fx-cricket{0%{opacity:0;transform:translate(0,4px) rotate(-8deg)}25%{opacity:.9}50%{transform:translate(4px,-8px) rotate(8deg)}75%{opacity:.8}100%{opacity:0;transform:translate(8px,-20px) rotate(-6deg)}}
.plz .fx-stamp{transform-origin:center;animation:plz-fx-stamp 5s ease-out infinite}
@keyframes plz-fx-stamp{0%{opacity:0;transform:scale(1.8) rotate(-20deg)}7%{opacity:1;transform:scale(.9) rotate(4deg)}11%{transform:scale(1.05) rotate(-2deg)}15%,70%{opacity:1;transform:scale(1) rotate(0)}100%{opacity:.35;transform:scale(1)}}
@keyframes plz-sign-swing{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
@keyframes plz-mote{0%{opacity:0;transform:translate(0,0)}20%{opacity:.85}50%{transform:translate(14px,-22px)}80%{opacity:.6}100%{opacity:0;transform:translate(26px,-40px)}}
@keyframes plz-machine-steam{0%,70%{opacity:0;transform:translateY(4px) scale(.5)}78%{opacity:.9}100%{opacity:0;transform:translateY(-14px) scale(1.4)}}
.plz .plz-world .plz-piece,.plz .plz-world .plz-actor,.plz .plz-world .plz-station,.plz .plz-world .plz-deskfx,.plz .plz-world .plz-lifefx,.plz .plz-world .plz-sign{transition:left .75s cubic-bezier(.3,.75,.25,1),top .75s cubic-bezier(.3,.75,.25,1)}
.plz .desk-over .dk-body,.plz .desk-over .dk-keys,.plz .desk-over .dk-item,.plz .desk-over .dk-monitor,.plz .desk-over .dk-box{transform-box:fill-box;transform-origin:50% 100%}
.plz .desk-over .dk-box-flap-l{transform-box:fill-box;transform-origin:100% 100%}
.plz .desk-over .dk-box-flap-r{transform-box:fill-box;transform-origin:0 100%}
@keyframes plz-fade-in{from{opacity:0}to{opacity:1}}
@keyframes plz-fade-out{to{opacity:0}}
.plz .desk-under.is-building{animation:plz-fade-in .5s ease-out both}
.plz .desk-over.is-building .dk-body{animation:plz-dk-rise .62s cubic-bezier(.2,.9,.3,1.25) .12s both}
@keyframes plz-dk-rise{0%{transform:scaleY(0);opacity:0}25%{opacity:1}100%{transform:scaleY(1)}}
.plz .desk-over.is-building .dk-keys{animation:plz-dk-drop .36s ease-out .55s both}
@keyframes plz-dk-drop{0%{transform:translateY(-26px);opacity:0}70%{transform:translateY(2px);opacity:1}100%{transform:none}}
.plz .desk-over.is-building .dk-monitor{animation:plz-dk-pop .44s cubic-bezier(.2,.9,.3,1.4) .66s both}
.plz .desk-over.is-building .dk-item{animation:plz-dk-pop .38s cubic-bezier(.2,.9,.3,1.6) .86s both}
@keyframes plz-dk-pop{0%{transform:scale(0);opacity:0}100%{transform:scale(1);opacity:1}}
.plz .plz-station.is-building .plz-plate{animation:plz-fade-in .4s ease-out .7s both}
.plz .desk-over.is-leaving .screen-glow,.plz .desk-over.is-leaving .screen-edge{animation:plz-fade-out .5s ease-in .3s forwards}
.plz .desk-over.is-leaving .dk-box{animation:plz-dk-box-in .35s cubic-bezier(.2,.9,.3,1.5) var(--t-pack) both,plz-dk-box-out .25s ease-in var(--t-down) forwards}
@keyframes plz-dk-box-in{0%{transform:scale(0)}100%{transform:scale(1)}}
@keyframes plz-dk-box-out{to{transform:translateY(-34px) scale(.5);opacity:0}}
.plz .desk-over.is-leaving .dk-item{animation:plz-dk-into-box .5s ease-in calc(var(--t-pack) + 280ms) forwards}
@keyframes plz-dk-into-box{0%{transform:none}45%{transform:translate(4px,-18px) rotate(10deg)}100%{transform:translate(6px,2px) scale(.15);opacity:0}}
.plz .desk-over.is-leaving .dk-keys{animation:plz-dk-keys-pack .55s ease-in calc(var(--t-pack) + 680ms) forwards}
@keyframes plz-dk-keys-pack{0%{transform:none}45%{transform:translate(-16px,-14px) rotate(-10deg)}100%{transform:translate(-38px,0) scale(.12);opacity:0}}
.plz .desk-over.is-leaving .dk-box-flap-l,.plz .desk-over.is-leaving .dk-box-flap-r{animation:plz-dk-flap .28s ease-in calc(var(--t-pack-end) - 260ms) forwards}
@keyframes plz-dk-flap{to{transform:scaleY(-.35)}}
.plz .desk-over.is-leaving .dk-monitor{animation:plz-dk-topple .5s ease-in var(--t-dismantle) forwards}
@keyframes plz-dk-topple{0%{transform:none}35%{transform:rotate(-14deg) translateY(-3px)}100%{transform:rotate(-32deg) scale(0);opacity:0}}
.plz .desk-over.is-leaving .dk-body{animation:plz-dk-fold var(--t-dismantle-ms) cubic-bezier(.5,0,.8,.4) calc(var(--t-dismantle) + 200ms) forwards}
@keyframes plz-dk-fold{0%{transform:none}25%{transform:scale(1.04,.95)}100%{transform:scale(.88,0);opacity:0}}
.plz .desk-under.is-leaving{animation:plz-fade-out .45s ease-in calc(var(--t-dismantle) + 420ms) forwards}
.plz .plz-station.is-leaving .plz-plate{animation:plz-fade-out .3s ease-in var(--t-dismantle) forwards}
.plz .plz-lifefx{position:absolute;width:0;height:0;pointer-events:none}
.plz .leave-bubble{position:absolute;white-space:nowrap;padding:5px 11px;border-radius:14px;background:#fff;color:#e2793b;font:700 13px/1.2 -apple-system,"PingFang SC",sans-serif;letter-spacing:.5px;box-shadow:0 2px 10px rgba(84,62,40,.15),0 0 0 1px rgba(84,62,40,.05);transform-origin:0 100%;animation-name:plz-leave-bubble;animation-duration:var(--t-down);animation-timing-function:ease-out;animation-delay:.1s;animation-fill-mode:both}
.plz .leave-bubble:after{content:"";position:absolute;left:9px;bottom:-3px;width:8px;height:8px;background:#fff;transform:rotate(45deg);border-radius:2px}
@keyframes plz-leave-bubble{0%{opacity:0;transform:scale(.3) rotate(-8deg)}8%{opacity:1;transform:scale(1.12) rotate(3deg)}13%{transform:scale(1) rotate(0)}88%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-8px)}}
.plz .leave-note{position:absolute;color:#f2a03d;font:700 15px Arial,sans-serif;text-shadow:0 0 3px #fff;opacity:0;animation:plz-leave-note 1.3s ease-out both}
@keyframes plz-leave-note{0%{opacity:0;transform:translate(0,4px) rotate(-10deg)}25%{opacity:1}100%{opacity:0;transform:translate(8px,-34px) rotate(12deg)}}
.plz .life-dust{position:absolute;width:16px;height:16px;border-radius:50%;background:rgba(226,218,206,.95);opacity:0;animation:plz-life-dust .7s ease-out both}
@keyframes plz-life-dust{0%{opacity:0;transform:scale(.3)}30%{opacity:.95}100%{opacity:0;transform:translate(var(--dx,0),-14px) scale(1.9)}}
.plz .life-dust:nth-child(odd){--dx:-8px}
.plz .build-spark{position:absolute;color:#f2c14e;font-size:14px;opacity:0;animation:plz-fx-twinkle .9s ease-in-out both}
.plz .capy-act[data-act="cheer"]{animation:plz-act-cheer .36s ease-in-out infinite}
@keyframes plz-act-cheer{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px) rotate(-2deg)}}
.plz .capy-act[data-act="pack"]{animation:plz-act-pack .55s ease-in-out infinite}
@keyframes plz-act-pack{0%,100%{transform:translate(-3px,2px) rotate(-3deg)}50%{transform:translate(-6px,-1px) rotate(-6deg)}}
.plz .capy-act[data-act="wave"]{animation:plz-act-wave .5s ease-in-out infinite}
@keyframes plz-act-wave{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg) translateY(-2px)}}
.plz .capy-carry{position:absolute;display:none;transform-origin:50% 100%;pointer-events:none}
.plz .capy[data-carry="true"] .capy-carry{display:block;animation:plz-carry-pop .3s cubic-bezier(.2,.9,.3,1.5) both}
@keyframes plz-carry-pop{from{transform:translateY(30px) scale(.4);opacity:0}to{transform:none;opacity:1}}
.plz .tok-rate{position:absolute;transform:translateX(-50%);display:inline-flex;align-items:center;gap:3px;padding:2px 7px 2px 5px;border-radius:10px;background:rgba(255,255,255,.94);box-shadow:0 1px 6px rgba(84,62,40,.13),0 0 0 1px rgba(84,62,40,.05);color:#60a5fa;white-space:nowrap;pointer-events:none;font-family:-apple-system,"PingFang SC",sans-serif}
.plz .tok-rate b{font-size:11px;font-weight:700;color:#3b4a5e;font-variant-numeric:tabular-nums;min-width:17px;text-align:right}
.plz .tok-rate small{font-size:9px;color:#9aa3ae;font-weight:500}
.plz .tok-rate svg{animation:plz-led-busy 1.2s ease-in-out infinite}
.plz .is-floor .tok-rate{scale:min(calc(.75 / var(--world-scale,1)),1.7);transform-origin:0 100%}
.plz .host-chip{font-style:normal;font-size:9.5px;font-weight:600;color:#9a9087;background:#efe9e1;border-radius:4px;padding:0 4px;margin-left:5px;line-height:15px;letter-spacing:.2px}
.plz .plz-station.selected .host-chip{background:#4a433d;color:#e8e2da}
.plz .is-floor .host-chip{display:none}
.plz .plz-station.is-sub .plz-plate strong{font-size:12px}
.plz .pennant{transform-box:fill-box;transform-origin:0 50%;animation:plz-pennant 2.6s ease-in-out infinite}
@keyframes plz-pennant{0%,100%{transform:skewY(0) scaleX(1)}50%{transform:skewY(-6deg) scaleX(.9)}}
.plz .plz-plate strong{max-width:100%;min-width:0}
.plz .plate-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.plz .sway{transform-box:fill-box;transform-origin:50% 100%;animation:plz-sway 5.5s ease-in-out infinite}
.plz .closed-sign{transform-box:fill-box;transform-origin:50% 0;animation:plz-sign-swing 3.4s ease-in-out infinite}
.plz.is-paused *,.plz.is-paused *::before,.plz.is-paused *::after{animation-play-state:paused!important}
`;

const STYLE_ID = "agent-observatory-plaza-styles";
/** Adds the stylesheet once per document; a newer plugin version replaces an older copy. */
export function ensurePlazaStyles(version: string): void {
  const doc = (globalThis as any).document;
  if (!doc?.head) return;
  let node = doc.getElementById(STYLE_ID);
  if (node?.dataset?.version === version) return;
  if (!node) { node = doc.createElement("style"); node.id = STYLE_ID; doc.head.appendChild(node); }
  node.dataset.version = version;
  node.textContent = CSS;
}
