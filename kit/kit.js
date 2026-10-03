/* AlphaPulse Kit v2 — icons, reveal, counters, tilt, magnetic buttons, card spotlight, progress, cursor glow, marquee duplication */
(() => {
  const rm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // icons: <i data-icon="rocket"></i> → Lucide SVG from the kit sprite
  $$("i[data-icon]").forEach((i) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", ("k-ic " + i.className).trim()); s.setAttribute("aria-hidden", "true"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttribute("href", "/_kit/icons.svg#" + i.dataset.icon); s.appendChild(u); i.replaceWith(s); });
  // stagger children: <div data-stagger> → children get --d
  $$("[data-stagger]").forEach((p) => [...p.children].forEach((c, i) => { if (!c.hasAttribute("data-reveal")) c.setAttribute("data-reveal", ""); c.style.setProperty("--d", (i * 0.08) + "s"); }));
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("k-in"); io.unobserve(e.target); } }), { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  $$("[data-reveal]").forEach((el) => io.observe(el));
  // counters: <b data-count="1200" data-suffix="+">0</b>
  const co = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return; co.unobserve(e.target);
    const el = e.target, to = parseFloat(el.dataset.count), dec = (el.dataset.count.split(".")[1] || "").length, suf = el.dataset.suffix || "", pre = el.dataset.prefix || "";
    if (rm) { el.textContent = pre + to.toFixed(dec) + suf; return; }
    const t0 = performance.now(), dur = 1600;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), v = to * (1 - Math.pow(1 - k, 3)); el.textContent = pre + v.toFixed(dec) + suf; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), { threshold: 0.4 });
  $$("[data-count]").forEach((el) => co.observe(el));
  if (!rm && matchMedia("(hover:hover)").matches) {
    // tilt
    $$(".k-tilt").forEach((el) => {
      el.addEventListener("pointermove", (e) => { const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5; el.style.transform = `perspective(900px) rotateY(${x * 8}deg) rotateX(${-y * 8}deg) translateY(-4px)`; });
      el.addEventListener("pointerleave", () => { el.style.transform = ""; });
    });
    // spotlight on cards
    $$(".k-card").forEach((el) => el.addEventListener("pointermove", (e) => { const r = el.getBoundingClientRect(); el.style.setProperty("--mx", e.clientX - r.left + "px"); el.style.setProperty("--my", e.clientY - r.top + "px"); }));
    // magnetic buttons
    $$(".k-btn-primary,[data-magnetic]").forEach((el) => {
      el.addEventListener("pointermove", (e) => { const r = el.getBoundingClientRect(); el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * 0.18}px,${(e.clientY - r.top - r.height / 2) * 0.25}px)`; });
      el.addEventListener("pointerleave", () => { el.style.transform = ""; });
    });
    // cursor glow
    if (document.body.hasAttribute("data-cursor")) { const c = document.createElement("div"); c.className = "k-cursor"; document.body.appendChild(c); addEventListener("pointermove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }); }
  }
  // scroll progress
  if (document.body.hasAttribute("data-progress")) { const p = document.createElement("div"); p.className = "k-progress"; document.body.appendChild(p); const f = () => { const h = document.documentElement; p.style.transform = `scaleX(${h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)})`; }; addEventListener("scroll", f, { passive: true }); f(); }
  // marquee: duplicate content once for seamless loop
  $$(".k-marquee>div").forEach((d) => { if (!d.dataset.dup) { d.innerHTML += d.innerHTML; d.dataset.dup = 1; } });
  // theme toggle: <button data-theme-toggle>
  $$("[data-theme-toggle]").forEach((b) => b.addEventListener("click", () => { const r = document.documentElement; r.dataset.theme = r.dataset.theme === "light" ? "dark" : "light"; }));
})();
