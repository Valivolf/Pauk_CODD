// Small hand-rolled inline-SVG chart helpers for /stats — no CDN charting
// library, since dispatcher machines on this LAN may have no internet
// access at all. Colors are read from CSS custom properties (set in
// stats.html, per data-theme — see the dataviz skill's palette pattern)
// so the theme toggle re-colors charts for free, no re-render needed.
//
// Every bar carries a direct text label (name + value) — per the dataviz
// skill, that's the "secondary encoding" that makes a borderline-close
// pair of hues in the categorical palette safe to ship (identity never
// rests on color alone here).

const esc_chart = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Horizontal bar chart. items: [{label, value, color}]. color is a CSS
// value (var(--vt-1), a hex, …) — literal or a custom property both work
// inline. Renders into `container` (an existing DOM node).
function barChart(container, items, opts = {}) {
  const { height = 28, gap = 10, emptyText = 'Нет данных' } = opts;
  if (!items.length) {
    container.innerHTML = `<p class="text-sm text-slate-500 text-center py-6">${esc_chart(emptyText)}</p>`;
    return;
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  const rowH = height + gap;
  const svgH = items.length * rowH - gap;
  const width = 100; // percent-based viewBox; scales to container via CSS width:100%

  const bars = items.map((it, i) => {
    const y = i * rowH;
    const w = Math.max(1, (it.value / max) * width);
    return `
      <g class="chart-row" data-tip="${esc_chart(it.label)}: ${it.value}">
        <text x="0" y="${y + height / 2 - 5}" class="chart-label">${esc_chart(it.label)}</text>
        <rect x="0" y="${y + height / 2}" width="${width}" height="6" rx="3" class="chart-track"></rect>
        <rect x="0" y="${y + height / 2}" width="${w}" height="6" rx="3" fill="${it.color}"></rect>
        <text x="${width}" y="${y + height / 2 - 5}" text-anchor="end" class="chart-value">${it.value}</text>
      </g>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${width} ${svgH}" class="chart-svg" preserveAspectRatio="none" style="height:${svgH * 3.2}px">${bars}</svg>`;
  wireChartTooltip(container);
}

// Small daily-count trend as vertical bars — one series (rose = "went
// down"), no legend needed for a single series.
function dailyTrendChart(container, items, opts = {}) {
  const { color = 'var(--rs-broken)', emptyText = 'Нет данных за период' } = opts;
  if (!items.length) {
    container.innerHTML = `<p class="text-sm text-slate-500 text-center py-6">${esc_chart(emptyText)}</p>`;
    return;
  }
  const max = Math.max(1, ...items.map((i) => i.count));
  const barW = 100 / items.length;
  const bars = items.map((it, i) => {
    const h = Math.max(2, (it.count / max) * 60);
    const x = i * barW + barW * 0.15;
    const w = barW * 0.7;
    return `<g class="chart-row" data-tip="${esc_chart(it.date)}: ${it.count}">
      <rect x="${x}" y="${60 - h}" width="${w}" height="${h}" rx="1.5" fill="${color}"></rect>
    </g>`;
  }).join('');
  container.innerHTML = `<svg viewBox="0 0 100 60" class="chart-svg" preserveAspectRatio="none" style="height:120px">${bars}</svg>`;
  wireChartTooltip(container);
}

// One shared floating tooltip element, positioned on hover over any
// `[data-tip]` group inside `container` — mirrors the skill's "hover
// layer by default" guidance without pulling in a charting library.
let _chartTooltipEl = null;
function wireChartTooltip(container) {
  if (!_chartTooltipEl) {
    _chartTooltipEl = document.createElement('div');
    _chartTooltipEl.className = 'chart-tooltip';
    document.body.appendChild(_chartTooltipEl);
  }
  container.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      _chartTooltipEl.textContent = el.dataset.tip;
      _chartTooltipEl.style.display = 'block';
    });
    el.addEventListener('mousemove', (e) => {
      _chartTooltipEl.style.left = e.clientX + 12 + 'px';
      _chartTooltipEl.style.top = e.clientY + 12 + 'px';
    });
    el.addEventListener('mouseleave', () => { _chartTooltipEl.style.display = 'none'; });
  });
}
