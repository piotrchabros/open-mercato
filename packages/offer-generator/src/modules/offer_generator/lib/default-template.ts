export const DEFAULT_OFFER_TEMPLATE = `<!DOCTYPE html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Oferta BlueBee</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400..700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@1&display=swap">
<style>
:root{--blue:#2257DF;--blue-300:#8EA9F0;--ink:#231F20;--ink-2:#3F3B3D;--muted:#6B6769;--paper:#F6F5F1;--white:#fff;--navy:#0A1638;--on-navy:#E8ECF7;--on-navy-muted:#A9B3D1;--line:rgba(35,31,32,.12);--line-strong:rgba(35,31,32,.28);--line-navy:rgba(232,236,247,.14);--line-navy-strong:rgba(232,236,247,.32);--f-sans:'Geist',system-ui,-apple-system,'Segoe UI',sans-serif;--f-mono:'Geist Mono',ui-monospace,'SF Mono',Menlo,monospace;--f-serif:'Instrument Serif','Iowan Old Style',Georgia,serif;--gutter:clamp(20px,4vw,48px);--section:clamp(64px,8vw,120px)}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--f-sans);font-size:1.0625rem;line-height:1.6;-webkit-font-smoothing:antialiased}
svg{display:block}
a{color:inherit}
p{margin:0}
h1,h2,h3,h4,h6{margin:0;font-weight:520;letter-spacing:-.03em;line-height:1.08;text-wrap:balance}
ul,ol,dl,dd{margin:0;padding:0}
.wrap{width:100%;max-width:1216px;margin-inline:auto;padding-inline:var(--gutter)}
.sec{padding-block:var(--section);position:relative}
.on-white{background:var(--white)}
.on-navy{background:var(--navy);color:var(--on-navy)}
.kicker{display:inline-flex;align-items:center;gap:10px;font-family:var(--f-mono);font-size:.75rem;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:var(--blue)}
.kicker::before{content:'';width:18px;height:1px;background:currentColor}
.on-navy .kicker{color:var(--blue-300)}
.mono,.lbl,.meta dt,.svc-txt h6,.price-per,.inc-title,.tbl th,.terms dt,.feat-badge{font-family:var(--f-mono);font-size:.75rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase}
.lbl,.meta dt,.svc-txt h6,.price-per,.inc-title,.tbl th,.terms dt{font-size:.68rem;letter-spacing:.12em;color:var(--muted)}
.muted{color:var(--muted)}
.on-navy .muted{color:var(--on-navy-muted)}
.serif{font-family:var(--f-serif);font-style:italic;font-weight:400;letter-spacing:-.01em}
.accent{color:var(--blue)}
.on-navy .accent{color:var(--blue-300)}
.h2{font-size:clamp(2rem,1.3rem + 2.6vw,3.4rem)}
.h3{font-size:clamp(1.15rem,1.05rem + .4vw,1.4rem);letter-spacing:-.02em;line-height:1.18;font-weight:560}
.lead{font-size:clamp(1.15rem,1rem + .6vw,1.5rem);line-height:1.45;letter-spacing:-.012em;color:var(--ink-2)}
.on-navy .lead{color:var(--on-navy)}
.sec-head{display:grid;gap:18px;margin-bottom:clamp(40px,5vw,64px)}
.sec-head .h2{max-width:20ch}
.sec-head p{max-width:58ch}
@media (min-width:960px){.sec-head.split{grid-template-columns:minmax(0,7fr) minmax(0,5fr);column-gap:64px;align-items:start}.sec-head.split .kicker{grid-column:1/-1}}
.btn{display:inline-flex;align-items:center;gap:12px;min-height:50px;padding:0 22px 0 24px;border-radius:999px;background:var(--blue);color:var(--white);border:1px solid var(--blue);font-weight:560;letter-spacing:-.01em;text-decoration:none;white-space:nowrap}
.btn.light{background:var(--white);color:var(--ink);border-color:var(--white)}
.btn.ghost{background:transparent;color:var(--on-navy);border-color:var(--line-navy-strong)}
.arr{width:18px;height:18px}
.hdr{border-bottom:1px solid var(--line)}
.hdr-in{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:76px}
.logo{display:inline-flex;align-items:center;gap:.32em;color:var(--ink);text-decoration:none;font-size:32px;line-height:1}
.logo-mark{height:1em;width:.93em;color:var(--blue);flex:none}
.logo-word{height:.62em;width:2.96em;flex:none}
.hdr-meta{color:var(--muted)}
.hero{position:relative;overflow:hidden;padding-block:clamp(56px,8vw,112px) clamp(48px,6vw,80px)}
.hero-grid{position:absolute;inset:0;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:88px 88px;-webkit-mask-image:radial-gradient(ellipse 70% 60% at 80% 30%,#000,transparent 70%);mask-image:radial-gradient(ellipse 70% 60% at 80% 30%,#000,transparent 70%);opacity:.7}
.hero .wrap{position:relative;display:grid;gap:28px}
.hero h1{font-size:clamp(2.6rem,1.3rem + 4.6vw,5.25rem);font-weight:500;letter-spacing:-.045em;line-height:1;max-width:18ch}
.hero h1 .serif{font-size:1.06em}
.hero .lead{max-width:52ch}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-top:clamp(16px,3vw,32px);border-top:1px solid var(--line-strong);font-family:var(--f-mono)}
.meta div{display:grid;gap:6px;padding:16px 16px 16px 0;border-bottom:1px solid var(--line)}
.meta dd{font-size:.9rem;letter-spacing:-.01em}
.svc-list{list-style:none;border-top:1px solid var(--line-strong)}
.svc-item{display:grid;grid-template-columns:56px minmax(0,1fr);gap:16px;padding:24px 0;border-bottom:1px solid var(--line)}
.svc-ic{font-family:var(--f-mono);font-size:.75rem;letter-spacing:.1em;color:var(--blue);padding-top:4px}
.svc-txt{display:grid;gap:8px;max-width:72ch}
.svc-txt h3{font-size:1.2rem;font-weight:580;letter-spacing:-.02em;line-height:1.25}
.svc-txt h6{margin-top:6px}
.svc-txt p,.svc-txt ul,.pkg-desc,.tl-row p,.why-cell p{font-size:.95rem;color:var(--muted)}
.svc-txt ul{padding-left:18px;display:grid;gap:4px}
.svc-txt li::marker{color:var(--blue)}
.steps{list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));border-top:1px solid var(--line-strong)}
.steps li{position:relative;display:grid;gap:12px;align-content:start;padding:32px 20px 24px;border-left:1px solid var(--line)}
.steps li::before{content:'';position:absolute;top:-6px;left:20px;width:11px;height:11px;border-radius:50%;background:var(--white);border:2px solid var(--blue)}
.steps .mono{color:var(--blue)}
.steps p{font-size:.95rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));padding:0 1px 1px 0}
.card{position:relative;display:grid;align-content:start;gap:4px;padding:28px;margin:0 -1px -1px 0;border:1px solid var(--line-strong);background:var(--paper)}
.card.featured{background:var(--white);border-color:var(--blue);box-shadow:inset 0 3px 0 var(--blue);z-index:1}
.card-top{display:grid;gap:4px;padding-bottom:20px;margin-bottom:8px;border-bottom:1px solid var(--line)}
.feat-badge{justify-self:start;padding:4px 12px;border-radius:999px;background:var(--blue);color:var(--white);font-size:.66rem}
.badge-spacer{height:24px}
.pkg-name{font-size:1.6rem;font-weight:540;letter-spacing:-.03em;margin-top:10px}
.price-was{margin-top:14px;font-family:var(--f-mono);font-size:.85rem;color:var(--muted);text-decoration:line-through}
.price-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;margin-top:4px}
.price-was+.price-row{margin-top:0}
.price-amt{font-size:2.6rem;font-weight:520;letter-spacing:-.045em;line-height:1}
.price-cur{font-size:1rem;font-weight:560}
.inc-title{margin:12px 0 4px}
.card .svc-list{border-top:0}
.card .svc-item{grid-template-columns:22px minmax(0,1fr);gap:10px;padding:10px 0}
.card .svc-item:last-child{border-bottom:0}
.card .svc-ic{padding-top:2px}
.card .svc-txt{font-size:.95rem}
.sub-head{display:grid;gap:12px;margin:clamp(48px,6vw,72px) 0 24px}
.tbl-wrap{overflow-x:auto;border-top:1px solid var(--line-strong)}
.tbl{width:100%;border-collapse:collapse;font-size:.95rem}
.tbl th,.tbl td{padding:14px 16px 14px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
.tbl th:not(:first-child),.tbl td:not(:first-child){text-align:right}
.tbl th:last-child,.tbl td:last-child{padding-right:0}
.tbl td.num,.tbl th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.tbl td.yes{color:var(--blue)}
.tbl tr.is-total td{font-weight:600;border-top:1px solid var(--line-strong);border-bottom:0}
.old-price{color:var(--muted);text-decoration:line-through;font-weight:400}
.footnote{margin-top:16px;font-size:.85rem;color:var(--muted);max-width:80ch}
.tl{list-style:none;border-top:1px solid var(--line-strong)}
.tl-row{display:grid;grid-template-columns:minmax(120px,2fr) minmax(0,10fr);gap:24px;padding:22px 0;border-bottom:1px solid var(--line)}
.tl-when{color:var(--blue);padding-top:4px}
.tl-row div{display:grid;gap:6px}
.tl-row p{max-width:68ch}
.terms{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));column-gap:64px;border-top:1px solid var(--line-strong)}
.terms div{display:grid;grid-template-columns:minmax(120px,4fr) minmax(0,7fr);gap:16px;padding:18px 0;border-bottom:1px solid var(--line)}
.terms dt{padding-top:3px}
.terms dd{font-size:.95rem}
.why-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));padding:0 1px 1px 0}
.why-cell{display:grid;gap:12px;align-content:start;padding:32px 28px 36px;margin:0 -1px -1px 0;border:1px solid var(--line)}
.why-icon{width:40px;height:40px;color:var(--blue);margin-bottom:6px}
.contact .wrap{display:grid;gap:48px}
@media (min-width:1000px){.contact .wrap{grid-template-columns:minmax(0,6fr) minmax(0,5fr);column-gap:80px;align-items:start}}
.contact .copy{display:grid;gap:22px;align-content:start}
.contact .h2{color:var(--white)}
.consult{list-style:none;margin-top:8px;border-top:1px solid var(--line-navy-strong)}
.consult li{display:grid;grid-template-columns:48px minmax(0,1fr);gap:8px;padding:16px 0;border-bottom:1px solid var(--line-navy)}
.consult .mono{color:var(--blue-300);padding-top:3px}
.consult p{color:var(--on-navy-muted)}
.consult strong{color:var(--white);font-weight:600}
.person{position:relative;display:grid;gap:14px;padding:clamp(28px,3.5vw,40px);background:var(--white);color:var(--ink)}
.person::after{content:'';position:absolute;left:0;bottom:-18px;width:36px;height:36px;background:var(--white);clip-path:polygon(0 0,100% 0,0 100%)}
.person-name{font-size:1.6rem;letter-spacing:-.03em;font-weight:540}
.person .lines{display:grid;gap:6px;padding:12px 0;border-block:1px solid var(--line);font-family:var(--f-mono);font-size:.85rem}
.person .lines a{text-decoration:none}
.person .btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.person .btn.ghost{color:var(--ink);border-color:var(--line-strong)}
.ftr{padding-block:56px 32px;border-top:1px solid var(--line-navy)}
.ftr-top{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:24px;padding-bottom:32px;border-bottom:1px solid var(--line-navy)}
.ftr .logo{color:var(--white);font-size:44px}
.ftr .logo-mark{color:var(--blue-300)}
.ftr .logo span{font-size:.78em;font-weight:600;letter-spacing:-.04em}
.ftr-tag{margin-top:14px;color:var(--on-navy-muted);font-size:1.1rem}
.ftr-bottom{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px 24px;padding-top:24px;color:var(--on-navy-muted)}
.ftr-bottom a{text-decoration:none;color:var(--on-navy)}
@media (max-width:760px){.svc-item{grid-template-columns:40px minmax(0,1fr)}.tl-row,.terms div{grid-template-columns:1fr;gap:6px}.hdr-meta{display:none}}
@media print{
@page{size:A4;margin:12mm 0}
body{font-size:10.5pt;background:var(--paper)}
.sec{padding-block:36px}
.hero{padding-block:36px 28px}
.hero h1{font-size:40pt}
.h2{font-size:24pt}
.lead{font-size:13pt}
.sec-head{margin-bottom:24px}
.on-navy,.on-white,.card.featured,.feat-badge,.btn,.person{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.card,.svc-item,.why-cell,.steps li,.tl-row,.terms div,.consult li,.tbl tr,.person,.meta div{break-inside:avoid;page-break-inside:avoid}
.sec-head,.sub-head,.sec-label{break-after:avoid;page-break-after:avoid}
.contact,.ftr{break-inside:avoid}
.tbl-wrap{overflow:visible}
.cards{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.card{padding:20px}
.steps{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}
}
</style>
</head>
<body>
<header class="hdr">
<div class="wrap hdr-in">
<a class="logo" href="https://bluebee.marketing" aria-label="BlueBee">
<svg class="logo-mark" viewBox="0 0 364 392" fill="currentColor" aria-hidden="true"><path d="M152 20q-9 2-14 14l-1 3-2 8-1 3-1 2v4l-1 7-1 8h-3l-10-6-6-4-23-13-38-17q-9-4-13-3-10 1-16 9l-6 19v19l1 5 1 3 1 4v4l1 2v1l1 2 3 9 1 1v1l2 3 3 5 4 6 3 4a69 69 0 0 0 33 25l3 1h1l2 1 3 1h2l4 1 8 1q11 0 4 4a226 226 0 0 0-30 42l-3 6-1 2-1 4-3 10q-3 7-3 22l1 12 1 4v2l1 2 7 18 12 17 14 14 3 3 8 6 3 3-5 13-1 3-1 1-2 4-3 5-7 12-9 13-1 2q-3 3 6 2l14-1 8-1h5l4-1 6-1 3-1h3l3-1 4-1h2l3-1 4-1h2l1-1 4-1 20-8a113 113 0 0 0 32-22l-4-4-5-6-2-2-4 3a79 79 0 0 1-23 15l-8 4-9 3-8 2-21 4q-6 3 1-10l13-32-19-11a114 114 0 0 1-25-28l-8-18-1-4-1-3 1-20 1-3 4-12 4-10a112 112 0 0 1 19-25 107 107 0 0 1 32-27l13-6 3-2 3-1 2-1h1l14-5 7-2 4-1h4l2-1 6-1h5l46 2h4l4 1 2 1 2 1 8 2 13 7a85 85 0 0 1 37 45c3 9 3 11 3 21 0 8 0 10-2 17l-1 2-8 15a75 75 0 0 1-37 26l-6 2-2 1-5 1h-6c-3 1-18 0-23-1l-8-3-12-7a68 68 0 0 1-24-37l-2-7-1-2h-30l1 3 4 15 1 4 1 4 2 3 11 20 4 6 8 8 4 3 4 4 4 2 1 1h1l9 5 23 7a168 168 0 0 0 37-1l3-1 12-4a101 101 0 0 0 51-40l1-3 10-24 1-4a106 106 0 0 0-2-37l-2-5-1-4a109 109 0 0 0-20-34l-4-4-4-4-6-5-4-3-13-8-3-2-11-5-4-1-4-2h-4l-4-1-3-1-3-1-17-2-12-1-5-11-8-15-27-41-23-20q-5-5-11-2m10 25q10 7 19 19a236 236 0 0 1 29 45l-4 1h-7l-6 1h-2q-2 1-5-1l-4-2-3-3-2-2-21-15-2-9 1-30 1-4 1-2q0-3 5 2M44 49l1 1 2 1 4 1 3 1 2 1 4 1 16 7 18 9 30 18 5 3 35 26-3 1h-2l-4 2-8 3-8 2-2 1-3 1h-3l-3 1-4 1c-9 2-22 2-30 1l-5-1-12-4c-1 0-7-2-10-5-4-2-10-8-12-10l-2-4-6-9v-1l-1-2-1-2-1-2-1-2v-3l-1-3v-1l-1-4-1-5V53q0-5 2-4z"/></svg>
<svg class="logo-word" viewBox="205.1 44.1 557.9 116.9" fill="currentColor" aria-hidden="true"><path d="M301 46v111l21 1V46zm-94 1v110l60-1 13-4 2-2q8-6 11-15v-4q2-6-1-13-2-8-8-11v-1l-2-1-2-1-6-2-4-1 2-1 7-3 3-3 2-1 1-1 1-2q5-8 3-20 1-5-2-8-4-7-9-9l-1-1-2-1-3-1-2-1-4-1-38-1zm50 17q9 2 10 9v8l-2 7-7 3-2 1h-28V64l14-1zm-1 46 6 1 2 1q4 1 6 6a21 21 0 0 1 0 15q-2 4-6 5l-2 1-7 1-3 1h-12l-11-1-1-15 1-15zm246-63-1 55 1 55 27 1 33-2 6-2 4-1 2-1 2-1a29 29 0 0 0 11-16l1-15-2-4c0-3-5-8-7-10l-7-3h-2l-3-1q-6-2 0-2l11-6 1-1v-1l2-3 2-4 1-3-1-16a24 24 0 0 0-10-13l-2-1q-4-3-8-3l-3-1-37-1zm49 17 2 1q5 1 8 6l1 7-1 7-4 4-3 2-3 1-15 1h-12l-1-1V64zm-10 45 15 2 3 1q3 1 5 5l1 2v6l-1 7q-2 5-6 6l-2 1-6 1-4 1h-23v-17l1-14c0-1-1-1 17-1m-92-37-3 1-15 6-12 12q-3 4-5 15a71 71 0 0 0 2 29l1 2q4 11 14 17l3 2 4 2 4 1 21 1 15-6 8-7 4-8q0-2-3-2l-3-1-2-1-2-1-2-1-2-1h-2l-3 2q-5 9-12 11-8 1-12-1h-1c-2 0-7-5-8-7l-1-2-1-2-1-2c-1-2-2-9-1-10h59a61 61 0 0 0-3-25l-4-8-2-3-3-4-2-1-2-1-1-1-1-1-3-1-10-3zm10 16q3-1 6 3l4 4 1 2c1 2 3 8 2 10v1h-38v-2l1-4 1-2 2-4 1-2 7-5c2-2 9-2 13-1m168-15-12 4-3 2-8 8-6 9-1 4-1 3a63 63 0 0 0 1 30l5 11c0 2 6 8 11 10l4 3 2 1 4 1a61 61 0 0 0 28-1l3-1 3-1 4-4q7-4 8-8l1-3q3-3-2-4l-3-1-2-1-1-1-2-1-2-1h-3l-2 3c-2 3-8 9-11 9l-2 1h-10l-3-1c-2-1-7-6-7-8l-1-1-1-2-1-1-1-3-1-7 29-1h30l1-7-3-19-2-2a34 34 0 0 0-12-15l-1-1-3-1-5-2-4-1-8-1zm13 15 4 1 3 3q5 3 7 14v2l-38-1v-3q2-7 7-12 7-7 17-4m78-16a49 49 0 0 0-19 7l-10 11-2 2-1 3-1 1-3 11v21l3 10 9 12 10 6 3 2 4 1 5 1a58 58 0 0 0 26-4l3-1 6-5 5-6 1-2q3-5-2-5l-2-1-3-1-2-1-1-1-3-1q-3-1-4 3-5 8-13 10l-12-1-6-4a33 33 0 0 1-7-17v-2h60l-2-21-1-4-1-2-1-1-1-3a35 35 0 0 0-14-14h-1l-3-1q-10-3-20-3m11 16 3 2 3 2 2 2 1 2 2 7 1 4v1h-38c-1-1 2-10 3-12l1-1 6-6 5-1zM333 75v64l1 3 1 3 1 2q0 2 5 6 6 6 13 7l13-1c3 0 9-3 10-4l2-3 4-5 2-2h1v6l1 6 9 1 9-1 1-40c0-46 0-42-3-42h-18v23l-3 34-1 2-2 5-2 1-1 1-3 1-3 1-9-1q-4-2-5-5l-2-2v-1l-1-29V75z"/></svg>
</a>
<span class="mono hdr-meta">Oferta nr 2026/11/014</span>
</div>
</header>

<main>
<section class="hero" data-section>
<div class="hero-grid" aria-hidden="true"></div>
<div class="wrap">
<p class="kicker sec-label">Oferta handlowa</p>
<h1>Marketing B2B, który pomaga klientom <em class="serif accent">zobaczyć powód wyboru.</em></h1>
<p class="lead"><!-- AI: one or two sentences tailored to the client and the brief -->Proponujemy uporządkowany system działań dla Firmy Przykładowej: od strategii i marki, przez stronę i kampanie, po pomiar zapytań. Tak, aby handlowcy rozmawiali z lepiej dopasowanymi klientami.</p>
<dl class="meta">
<div><dt>Klient</dt><dd>Firma Przykładowa Sp. z o.o.</dd></div>
<div><dt>Data</dt><dd>5 listopada 2026</dd></div>
<div><dt>Ważna do</dt><dd>5 grudnia 2026</dd></div>
<div><dt>Opiekun</dt><dd>Piotr Chabros</dd></div>
</dl>
</div>
</section>

<section class="sec" data-section>
<div class="wrap">
<div class="sec-head split">
<p class="kicker sec-label">Zakres współpracy</p>
<h2 class="h2">Jeden kierunek. <em class="serif">Kilka narzędzi.</em></h2>
<p class="lead">Układamy marketing jak system, w którym każde działanie wspiera ten sam cel biznesowy.</p>
</div>
<ul class="svc-list">
<li class="svc-item"><span class="svc-ic">01</span><div class="svc-txt"><h3>Strategia marketingu B2B</h3><p>Określamy grupy docelowe, kluczowe przewagi i argumenty, które skracają drogę do decyzji.</p></div></li>
<li class="svc-item"><span class="svc-ic">02</span><div class="svc-txt"><h3>Strona internetowa B2B</h3><p>Projektujemy stronę, która tłumaczy ofertę, buduje wiarygodność i prowadzi do kontaktu.</p><h6>W ramach etapu</h6><ul><li>architektura informacji i makiety kluczowych podstron</li><li>copywriting sprzedażowy</li><li>wdrożenie i konfiguracja analityki</li></ul></div></li>
<li class="svc-item"><span class="svc-ic">03</span><div class="svc-txt"><h3>Kampanie Google Ads i LinkedIn Ads</h3><p>Docieramy do firm, które szukają rozwiązań, oraz do konkretnych branż i stanowisk.</p></div></li>
<li class="svc-item"><span class="svc-ic">04</span><div class="svc-txt"><h3>Content i materiały sprzedażowe</h3><p>Case studies, prezentacje i one-pagery, które wspierają handlowców w rozmowach.</p></div></li>
</ul>
</div>
</section>

<section class="sec on-white" data-section>
<div class="wrap">
<div class="sec-head split">
<p class="kicker sec-label">Jak pracujemy</p>
<h2 class="h2">Najpierw poznajemy biznes, potem dobieramy narzędzia.</h2>
<p class="lead">Każdy etap kończy się konkretnym rezultatem, który akceptujesz przed przejściem dalej.</p>
</div>
<ol class="steps">
<li><span class="mono">01</span><h3 class="h3">Diagnoza</h3><p class="muted">Rozmowy z zarządem i handlowcami, audyt strony, kampanii i źródeł zapytań.</p></li>
<li><span class="mono">02</span><h3 class="h3">Strategia</h3><p class="muted">Grupy docelowe, powód wyboru, komunikacja i plan działań na 6 miesięcy.</p></li>
<li><span class="mono">03</span><h3 class="h3">Wdrożenie</h3><p class="muted">Strona, materiały sprzedażowe i konfiguracja pomiaru.</p></li>
<li><span class="mono">04</span><h3 class="h3">Kampanie</h3><p class="muted">Start kampanii i treści eksperckich, cotygodniowa optymalizacja.</p></li>
<li><span class="mono">05</span><h3 class="h3">Rozwój</h3><p class="muted">Miesięczne raporty jakości zapytań i decyzje o kolejnych krokach.</p></li>
</ol>
</div>
</section>

<section class="sec" data-section>
<div class="wrap">
<div class="sec-head split">
<p class="kicker sec-label">Pakiety</p>
<h2 class="h2">Wybierz zakres dopasowany do etapu firmy.</h2>
<p class="lead">Wszystkie pakiety obejmują opiekuna projektu i miesięczny raport.</p>
</div>
<div class="cards">
<div class="card">
<div class="card-top">
<div class="badge-spacer"></div>
<div class="pkg-name">Start</div>
<p class="pkg-desc">Fundamenty i pierwsze kampanie.</p>
<div class="price-row"><span class="price-amt">4 900</span><span class="price-cur">PLN</span><span class="price-per">netto / mies.</span></div>
</div>
<div class="inc-title">W pakiecie</div>
<ul class="svc-list">
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Strategia komunikacji i persony</span></li>
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Kampania Google Ads</span></li>
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Raport miesięczny</span></li>
</ul>
</div>
<div class="card featured">
<div class="card-top">
<span class="feat-badge">Rekomendowany</span>
<div class="pkg-name">Wzrost</div>
<p class="pkg-desc">Strona, kampanie i content w jednym rytmie.</p>
<div class="price-was">10 500 PLN</div>
<div class="price-row"><span class="price-amt">8 900</span><span class="price-cur">PLN</span><span class="price-per">netto / mies.</span></div>
</div>
<div class="inc-title">W pakiecie</div>
<ul class="svc-list">
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Wszystko z pakietu Start</span></li>
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Kampanie LinkedIn Ads</span></li>
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">4 treści eksperckie miesięcznie</span></li>
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Optymalizacja strony pod konwersję</span></li>
</ul>
</div>
<div class="card">
<div class="card-top">
<div class="badge-spacer"></div>
<div class="pkg-name">Partner</div>
<p class="pkg-desc">Zewnętrzny dział marketingu.</p>
<div class="price-row"><span class="price-amt">14 900</span><span class="price-cur">PLN</span><span class="price-per">netto / mies.</span></div>
</div>
<div class="inc-title">W pakiecie</div>
<ul class="svc-list">
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Wszystko z pakietu Wzrost</span></li>
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Materiały sprzedażowe i case studies</span></li>
<li class="svc-item"><span class="svc-ic">+</span><span class="svc-txt">Automatyzacja obsługi zapytań</span></li>
</ul>
</div>
</div>

<div class="sub-head">
<p class="kicker">Porównanie pakietów</p>
<h3 class="h3">Co dokładnie obejmuje każdy pakiet</h3>
</div>
<div class="tbl-wrap">
<table class="tbl">
<thead><tr><th>Zakres</th><th>Start</th><th>Wzrost</th><th>Partner</th></tr></thead>
<tbody>
<tr><td>Strategia i persony</td><td class="yes">✓</td><td class="yes">✓</td><td class="yes">✓</td></tr>
<tr><td>Google Ads</td><td class="yes">✓</td><td class="yes">✓</td><td class="yes">✓</td></tr>
<tr><td>LinkedIn Ads</td><td>—</td><td class="yes">✓</td><td class="yes">✓</td></tr>
<tr><td>Treści eksperckie</td><td>—</td><td>4 / mies.</td><td>8 / mies.</td></tr>
<tr><td>Materiały sprzedażowe</td><td>—</td><td>—</td><td class="yes">✓</td></tr>
<tr class="is-total"><td>Cena netto / mies.</td><td class="num">4 900 PLN</td><td class="num"><s class="old-price">10 500 PLN</s> 8 900 PLN</td><td class="num">14 900 PLN</td></tr>
</tbody>
</table>
</div>
<p class="footnote">Ceny netto, do których należy doliczyć 23% VAT. Budżet mediowy kampanii nie jest wliczony w cenę pakietu.</p>
</div>
</section>

<section class="sec on-white" data-section>
<div class="wrap">
<div class="sec-head split">
<p class="kicker sec-label">Harmonogram</p>
<h2 class="h2">Pierwsze efekty po 6 tygodniach.</h2>
<p class="lead">Terminy liczymy od dnia podpisania umowy i warsztatu startowego.</p>
</div>
<ol class="tl">
<li class="tl-row"><span class="mono tl-when">Tydz. 1–2</span><div><h3 class="h3">Diagnoza i warsztat</h3><p>Wywiady, audyt i ustalenie celów na pierwsze 6 miesięcy.</p></div></li>
<li class="tl-row"><span class="mono tl-when">Tydz. 3–4</span><div><h3 class="h3">Strategia i plan działań</h3><p>Akceptacja komunikacji, person i budżetu mediowego.</p></div></li>
<li class="tl-row"><span class="mono tl-when">Tydz. 5–6</span><div><h3 class="h3">Start kampanii</h3><p>Uruchomienie kampanii, pomiaru i pierwszych treści.</p></div></li>
<li class="tl-row"><span class="mono tl-when">Od mies. 2</span><div><h3 class="h3">Optymalizacja</h3><p>Cotygodniowe korekty i comiesięczne spotkanie podsumowujące.</p></div></li>
</ol>
</div>
</section>

<section class="sec" data-section>
<div class="wrap">
<div class="sec-head split">
<p class="kicker sec-label">Warunki współpracy</p>
<h2 class="h2">Jasne zasady od pierwszego dnia.</h2>
</div>
<dl class="terms">
<div><dt>Rozliczenie</dt><dd>Abonament miesięczny, faktura z góry do 5. dnia miesiąca.</dd></div>
<div><dt>Płatność</dt><dd>Przelew, termin 14 dni.</dd></div>
<div><dt>Okres</dt><dd>Minimum 3 miesiące, potem miesięczny okres wypowiedzenia.</dd></div>
<div><dt>Budżet mediowy</dt><dd>Opłacany bezpośrednio przez klienta w systemach reklamowych.</dd></div>
<div><dt>Prawa autorskie</dt><dd>Przechodzą na klienta z chwilą zapłaty faktury.</dd></div>
<div><dt>Ważność oferty</dt><dd>30 dni od daty wystawienia.</dd></div>
</dl>
</div>
</section>

<section class="sec on-white" data-section>
<div class="wrap">
<div class="sec-head split">
<p class="kicker sec-label">Dlaczego BlueBee</p>
<h2 class="h2">Strategia, która przechodzi do wdrożenia.</h2>
<p class="lead">Łączymy doświadczenie in-house, specjalistów i opiekę nad projektem wokół celów biznesowych klienta.</p>
</div>
<div class="why-row">
<div class="why-cell"><svg class="why-icon" viewBox="0 0 40 40" aria-hidden="true"><path d="M6 30 C 12 10, 26 8, 34 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="34" cy="14" r="3.2" fill="currentColor"/></svg><h3 class="h3">Doświadczenie in-house</h3><p>Znamy marketing z perspektywy zarządów, budżetów i realnego wdrożenia.</p></div>
<div class="why-cell"><svg class="why-icon" viewBox="0 0 40 40" aria-hidden="true"><path d="M6 30 C 12 10, 26 8, 34 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="34" cy="14" r="3.2" fill="currentColor"/></svg><h3 class="h3">Jeden opiekun projektu</h3><p>Osoba prowadząca zna kontekst, pilnuje priorytetów i spina pracę zespołu.</p></div>
<div class="why-cell"><svg class="why-icon" viewBox="0 0 40 40" aria-hidden="true"><path d="M6 30 C 12 10, 26 8, 34 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="34" cy="14" r="3.2" fill="currentColor"/></svg><h3 class="h3">Zrozumienie decyzji B2B</h3><p>Projektujemy komunikację, która wspiera decyzję wielu osób po stronie klienta.</p></div>
</div>
</div>
</section>

<section class="sec on-navy contact" data-section>
<div class="wrap">
<div class="copy">
<p class="kicker sec-label">Kolejny krok</p>
<h2 class="h2">Porozmawiajmy o <em class="serif accent">Twoich celach.</em></h2>
<p class="lead">Odpowiemy na pytania i dopasujemy zakres, zanim podpiszemy umowę.</p>
<ol class="consult">
<li><span class="mono">01</span><p><strong>Rozmowa 30 minut.</strong> Omawiamy ofertę i Twoje priorytety.</p></li>
<li><span class="mono">02</span><p><strong>Doprecyzowanie zakresu.</strong> Wybieramy pakiet i termin startu.</p></li>
<li><span class="mono">03</span><p><strong>Warsztat startowy.</strong> Ruszamy w ciągu 7 dni od akceptacji.</p></li>
</ol>
</div>
<div class="person">
<p class="lbl">Opiekun oferty</p>
<p class="person-name">Piotr Chabros</p>
<div class="lines"><a href="mailto:hello@bluebee.marketing">hello@bluebee.marketing</a><a href="tel:+48667582525">+48 667 582 525</a></div>
<div class="btns">
<a class="btn" href="mailto:hello@bluebee.marketing">Akceptuję ofertę<svg class="arr" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 4.5 16.5 10 11 15.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
<a class="btn ghost" href="tel:+48667582525">Zadzwoń</a>
</div>
</div>
</div>
</section>
</main>

<footer class="ftr on-navy">
<div class="wrap">
<div class="ftr-top">
<div>
<a class="logo" href="https://bluebee.marketing" aria-label="BlueBee"><svg class="logo-mark" viewBox="0 0 364 392" fill="currentColor" aria-hidden="true"><path d="M152 20q-9 2-14 14l-1 3-2 8-1 3-1 2v4l-1 7-1 8h-3l-10-6-6-4-23-13-38-17q-9-4-13-3-10 1-16 9l-6 19v19l1 5 1 3 1 4v4l1 2v1l1 2 3 9 1 1v1l2 3 3 5 4 6 3 4a69 69 0 0 0 33 25l3 1h1l2 1 3 1h2l4 1 8 1q11 0 4 4a226 226 0 0 0-30 42l-3 6-1 2-1 4-3 10q-3 7-3 22l1 12 1 4v2l1 2 7 18 12 17 14 14 3 3 8 6 3 3-5 13-1 3-1 1-2 4-3 5-7 12-9 13-1 2q-3 3 6 2l14-1 8-1h5l4-1 6-1 3-1h3l3-1 4-1h2l3-1 4-1h2l1-1 4-1 20-8a113 113 0 0 0 32-22l-4-4-5-6-2-2-4 3a79 79 0 0 1-23 15l-8 4-9 3-8 2-21 4q-6 3 1-10l13-32-19-11a114 114 0 0 1-25-28l-8-18-1-4-1-3 1-20 1-3 4-12 4-10a112 112 0 0 1 19-25 107 107 0 0 1 32-27l13-6 3-2 3-1 2-1h1l14-5 7-2 4-1h4l2-1 6-1h5l46 2h4l4 1 2 1 2 1 8 2 13 7a85 85 0 0 1 37 45c3 9 3 11 3 21 0 8 0 10-2 17l-1 2-8 15a75 75 0 0 1-37 26l-6 2-2 1-5 1h-6c-3 1-18 0-23-1l-8-3-12-7a68 68 0 0 1-24-37l-2-7-1-2h-30l1 3 4 15 1 4 1 4 2 3 11 20 4 6 8 8 4 3 4 4 4 2 1 1h1l9 5 23 7a168 168 0 0 0 37-1l3-1 12-4a101 101 0 0 0 51-40l1-3 10-24 1-4a106 106 0 0 0-2-37l-2-5-1-4a109 109 0 0 0-20-34l-4-4-4-4-6-5-4-3-13-8-3-2-11-5-4-1-4-2h-4l-4-1-3-1-3-1-17-2-12-1-5-11-8-15-27-41-23-20q-5-5-11-2m10 25q10 7 19 19a236 236 0 0 1 29 45l-4 1h-7l-6 1h-2q-2 1-5-1l-4-2-3-3-2-2-21-15-2-9 1-30 1-4 1-2q0-3 5 2M44 49l1 1 2 1 4 1 3 1 2 1 4 1 16 7 18 9 30 18 5 3 35 26-3 1h-2l-4 2-8 3-8 2-2 1-3 1h-3l-3 1-4 1c-9 2-22 2-30 1l-5-1-12-4c-1 0-7-2-10-5-4-2-10-8-12-10l-2-4-6-9v-1l-1-2-1-2-1-2-1-2v-3l-1-3v-1l-1-4-1-5V53q0-5 2-4z"/></svg><span>BlueBee</span></a>
<p class="ftr-tag">Strategiczny partner w marketingu i brandingu B2B.</p>
</div>
<a class="btn light" href="https://bluebee.marketing">bluebee.marketing</a>
</div>
<div class="ftr-bottom mono">
<span>© 2026 BlueBee · Bespokesoft Piotr Chabros</span>
<span>Pastewna 27b, 02-954 Warszawa · NIP 7010510120</span>
<a href="mailto:hello@bluebee.marketing">hello@bluebee.marketing</a>
</div>
</div>
</footer>
</body>
</html>`
