/* AlphaPulse Motion v2 — GSAP + ScrollTrigger + SplitText + Lenis, driven by data attributes.
   Static fallback (final state, no pin) when GSAP is missing, prefers-reduced-motion, or review screenshots. */
(() => {
  const d = document, root = d.documentElement;
  const G = window.gsap, ST = window.ScrollTrigger, Split = window.SplitText, L = window.Lenis;
  const rm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const shot = !!window.__KIT_SHOT;
  const $$ = (s, r = d) => [...r.querySelectorAll(s)];
  const num = (v, def) => (v === undefined || v === "" || isNaN(+v) ? def : +v);
  if (!G || !ST || rm || shot) { root.classList.add("k-static"); window.KitMotion = { static: true }; return; }
  G.registerPlugin(ST); if (Split) G.registerPlugin(Split);
  root.classList.add("k-motion");
  const mm = G.matchMedia();
  const desk = "(min-width: 900px)";

  /* smooth scroll */
  let lenis = null;
  if (L && !root.hasAttribute("data-no-smooth") && !d.body.hasAttribute("data-no-smooth")) {
    lenis = new L({ lerp: 0.09, smoothWheel: true, anchors: { offset: -80 } });
    lenis.on("scroll", ST.update);
    G.ticker.add((t) => lenis.raf(t * 1000));
    G.ticker.lagSmoothing(0);
  }

  /* text reveal: data-split="lines|words|chars" (+ data-delay) */
  $$("[data-split]").forEach((el) => {
    const kind = el.dataset.split || "lines", delay = num(el.dataset.delay, 0);
    const trig = { trigger: el, start: "top 88%", once: true };
    const plain = () => { el.classList.add("k-split-done"); G.from(el, { y: 40, opacity: 0, duration: 1, ease: "expo.out", delay, scrollTrigger: trig }); };
    if (!Split || el.matches(".k-gradient-text") || el.querySelector(".k-gradient-text,svg,img")) return plain();
    try {
      Split.create(el, {
        type: kind === "chars" ? "words,chars" : kind === "words" ? "words" : "lines",
        mask: kind === "chars" ? undefined : kind, autoSplit: true,
        onSplit(self) {
          el.classList.add("k-split-done");
          const t = kind === "chars" ? self.chars : kind === "words" ? self.words : self.lines;
          return G.from(t, kind === "chars"
            ? { opacity: 0, yPercent: 60, rotate: 8, duration: 0.7, ease: "expo.out", stagger: 0.016, delay, scrollTrigger: trig }
            : { yPercent: 115, duration: 1.05, ease: "expo.out", stagger: kind === "words" ? 0.035 : 0.1, delay, scrollTrigger: trig });
        },
      });
    } catch { plain(); }
  });

  /* hero intro: children slide in on load — data-intro on a container */
  $$("[data-intro]").forEach((el) => G.from(el.children, { y: 28, opacity: 0, duration: 0.9, ease: "expo.out", stagger: 0.09, delay: num(el.dataset.intro, 0.15) }));

  /* words light up while scrolling (Apple style) — data-text-scrub */
  $$("[data-text-scrub]").forEach((el) => {
    let words;
    if (Split) words = Split.create(el, { type: "words" }).words;
    else { el.innerHTML = el.textContent.trim().split(/\s+/).map((w) => `<span>${w}</span>`).join(" "); words = [...el.children]; }
    G.fromTo(words, { opacity: 0.14 }, { opacity: 1, stagger: 0.1, ease: "none", scrollTrigger: { trigger: el, start: "top 82%", end: "bottom 42%", scrub: 0.6 } });
  });

  /* parallax depth — data-parallax="0.3" (negative = opposite direction) */
  $$("[data-parallax]").forEach((el) => {
    const s = num(el.dataset.parallax, 0.2);
    G.fromTo(el, { y: () => s * 160 }, { y: () => -s * 160, ease: "none", scrollTrigger: { trigger: el, start: "top bottom", end: "bottom top", scrub: true, invalidateOnRefresh: true } });
  });

  /* big visual grows into place — data-scale */
  $$("[data-scale]").forEach((el) => G.fromTo(el, { scale: num(el.dataset.scale, 0.84), opacity: 0.5 }, { scale: 1, opacity: 1, ease: "none", scrollTrigger: { trigger: el, start: "top 96%", end: "top 40%", scrub: 0.5 } }));

  /* clip reveal — data-clip */
  $$("[data-clip]").forEach((el) => G.fromTo(el, { clipPath: "inset(16% 12% 16% 12% round 28px)", scale: 1.04 }, { clipPath: "inset(0% 0% 0% 0% round 0px)", scale: 1, duration: 1.3, ease: "expo.out", scrollTrigger: { trigger: el, start: "top 85%", once: true } }));

  /* SVG line drawing — data-draw on an <svg> (or a path); data-draw="scrub" ties it to scroll */
  $$("[data-draw]").forEach((el) => {
    const paths = el.matches("svg") ? $$("path,line,polyline,polygon,circle,rect,ellipse", el) : [el];
    paths.forEach((p) => { try { const len = p.getTotalLength(); p.style.strokeDasharray = len; p.style.strokeDashoffset = len; } catch {} });
    const scrub = el.dataset.draw === "scrub";
    G.to(paths, { strokeDashoffset: 0, duration: 1.8, ease: "power2.inOut", stagger: 0.12, scrollTrigger: scrub ? { trigger: el, start: "top 80%", end: "bottom 40%", scrub: 0.6 } : { trigger: el, start: "top 85%", once: true } });
  });

  /* ambient loops — data-float (floating UI cards), data-spin="seconds" (orbit rings) */
  $$("[data-float]").forEach((el, i) => G.to(el, { y: -num(el.dataset.float, 14), duration: 2.4 + (i % 3) * 0.5, ease: "sine.inOut", yoyo: true, repeat: -1, delay: i * 0.3 }));
  $$("[data-spin]").forEach((el) => G.to(el, { rotation: 360, duration: num(el.dataset.spin, 40), ease: "none", repeat: -1 }));

  /* pinned storytelling — section[data-pin] with .k-stage > [data-step] (+ optional .k-stage > [data-step-visual]) */
  $$("[data-pin]").forEach((sec) => {
    const steps = $$("[data-step]", sec);
    mm.add(desk, () => {
      if (!steps.length) { ST.create({ trigger: sec, start: "top top", end: `+=${num(sec.dataset.pin, 100)}%`, pin: true }); return; }
      const vis = $$("[data-step-visual]", sec);
      sec.classList.add("k-pinned");
      const pair = (i) => [steps[i], vis[i]].filter(Boolean);
      steps.forEach((_, i) => { if (i) G.set(pair(i), { autoAlpha: 0, y: 50 }); });
      const tl = G.timeline({ scrollTrigger: { trigger: sec, start: "top top", end: () => `+=${steps.length * innerHeight * 0.85}`, pin: true, scrub: 0.6, snap: steps.length > 1 ? { snapTo: "labels", duration: 0.5, ease: "power2.inOut" } : false, invalidateOnRefresh: true } });
      tl.addLabel("s0");
      steps.forEach((_, i) => {
        if (!i) return;
        tl.to(pair(i - 1), { autoAlpha: 0, y: -50, duration: 0.5 }).to(pair(i), { autoAlpha: 1, y: 0, duration: 0.5 }, "<0.15").addLabel(`s${i}`).to({}, { duration: 0.35 });
      });
      $$("[data-step-progress]", sec).forEach((b) => tl.fromTo(b, { scaleX: 0 }, { scaleX: 1, ease: "none", duration: tl.duration() }, 0));
      return () => { sec.classList.remove("k-pinned"); G.set(steps.concat(vis), { clearProps: "all" }); };
    });
  });

  /* horizontal gallery — section[data-horizontal] > .k-track */
  $$("[data-horizontal]").forEach((sec) => {
    const track = sec.querySelector(".k-track"); if (!track) return;
    mm.add(desk, () => {
      sec.classList.add("k-hpinned");
      const dist = () => Math.max(0, track.scrollWidth - track.clientWidth);
      G.to(track, { x: () => -dist(), ease: "none", scrollTrigger: { trigger: sec, start: "top top", end: () => `+=${dist()}`, pin: true, scrub: 0.8, invalidateOnRefresh: true } });
      return () => sec.classList.remove("k-hpinned");
    });
  });

  /* background colour shift per section — data-bg="#0b0b12" */
  const bg0 = getComputedStyle(root).getPropertyValue("--k-bg").trim();
  $$("[data-bg]").forEach((sec) => {
    const to = (c) => G.to(root, { "--k-bg": c, duration: 0.7, ease: "power2.out", overwrite: "auto" });
    ST.create({ trigger: sec, start: "top 55%", end: "bottom 45%", onEnter: () => to(sec.dataset.bg), onEnterBack: () => to(sec.dataset.bg), onLeave: () => to(bg0), onLeaveBack: () => to(bg0) });
  });

  /* nav hides on scroll down, returns on scroll up — .k-nav[data-autohide] */
  $$(".k-nav[data-autohide]").forEach((nav) => ST.create({ start: 0, end: "max", onUpdate: (s) => nav.classList.toggle("k-nav-hidden", s.direction === 1 && s.scroll() > 240) }));

  /* staggered cards on enter — data-batch on a grid */
  $$("[data-batch]").forEach((grid) => {
    const items = [...grid.children]; G.set(items, { y: 46, opacity: 0 });
    ST.batch(items, { start: "top 90%", once: true, onEnter: (b) => G.to(b, { y: 0, opacity: 1, duration: 0.9, ease: "expo.out", stagger: 0.08, overwrite: true }) });
  });

  d.fonts?.ready.then(() => ST.refresh());
  addEventListener("load", () => ST.refresh());
  window.KitMotion = { gsap: G, ScrollTrigger: ST, lenis, refresh: () => ST.refresh() };
})();
