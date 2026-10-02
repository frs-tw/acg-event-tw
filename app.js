// 資料：data/meta.json（類型、縣市）、data/places.json（地點庫）、data/events.json（活動，含 city）
// 時間軸預設顯示「上個月 1 日」起 12 個月，可縮放與左右捲動；季度以色帶標在月份上方。
// 點時間軸上的活動，右側 Inspector 顯示詳細資料（類似 Unity 的 Inspector）。
const TYPE_COLOR = { popup: "var(--t-popup)", expo: "var(--t-expo)", doujin: "var(--t-doujin)", cafe: "var(--t-cafe)" };
const DAY = 864e5;
const NAME_W = () => (window.innerWidth <= 560 ? 150 : 260); // 與 CSS 的 --name-w 一致
const MIN_PPD = 0.6, MAX_PPD = 60;                           // 每天幾 px
// 每天幾 px 以上才顯示：週六日底色、每日格線、日期列、日期列的星期
const DAY_LEVEL = { weekend: 2.5, lines: 8, row: 14, weekday: 26 };

const d = s => new Date(s + "T00:00:00");
const addMonths = (dt, n) => new Date(dt.getFullYear(), dt.getMonth() + n, 1);
const md = dt => `${dt.getMonth() + 1}/${String(dt.getDate()).padStart(2, "0")}`;
const quarterOf = dt => `${dt.getFullYear()} Q${Math.floor(dt.getMonth() / 3) + 1}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = id => document.getElementById(id);
const getJSON = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url} ${r.status}`); return r.json(); });

const today = new Date(); today.setHours(0, 0, 0, 0);
const VIEW0 = addMonths(today, -1);          // 預設視窗起點：上個月 1 日
const VIEW1 = addMonths(VIEW0, 12);          // 預設視窗終點（不含）

let META, PLACES, EVENTS, T0, T1, ppd = 1;
let LIST = [], sel = null;                  // 目前顯示的活動與選取的活動
const filter = { type: new Set(), place: new Set() };
let hideEnded = false;                        // 隱藏已結束的活動（記在瀏覽器）
try { hideEnded = localStorage.getItem("acg-hide-ended") === "1"; } catch (e) {}
let city = null;                              // 目前的縣市分頁（一次只顯示一個縣市）

Promise.all([getJSON("data/meta.json"), getJSON("data/places.json"), getJSON("data/events.json")])
  .then(([meta, places, events]) => {
    META = meta; PLACES = places;
    // 沒有日期的活動不顯示；已在預設視窗之前結束的也不顯示
    EVENTS = events.filter(e => e.start && e.end && d(e.end) >= VIEW0);

    // 時間軸總範圍：預設視窗，再延伸到涵蓋所有活動（以月為單位）
    const starts = EVENTS.map(e => d(e.start)), ends = EVENTS.map(e => d(e.end));
    const minS = new Date(Math.min(VIEW0, ...starts)), maxE = new Date(Math.max(VIEW1 - DAY, ...ends));
    T0 = new Date(minS.getFullYear(), minS.getMonth(), 1);
    T1 = addMonths(maxE, 1);

    initCity();
    $("city-tabs").addEventListener("keydown", ev => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      const codes = Object.keys(META.cities), i = codes.indexOf(city);
      switchCity(codes[(i + (ev.key === "ArrowRight" ? 1 : codes.length - 1)) % codes.length]);
    });
    chips("f-type", meta.types, "type", true);
    renderPlaceChips();
    setupZoom();
    setupSelect();
    initMap();
    setupSplitter();
    setupMapSplit();
    setupFilterScroll();
    setupPanelDrag();
    renderAbout();
    sel = defaultSelection(visible());
    render();
    zoomToMonths(3, VIEW0);
  })
  .catch(() => {
    $("insp-body").innerHTML = `<div class="i-empty">讀不到資料。直接雙擊開啟 index.html 會被瀏覽器擋下，請用本機伺服器開啟（見 README）。</div>`;
  });

/* ---------- 縣市分頁 ---------- */

// 分頁順序照 meta.json；網址 #taipei 可直接開某縣市，否則用上次看的，再不然用第一個有活動的
function initCity() {
  const codes = Object.keys(META.cities);
  let saved = null;
  try { saved = localStorage.getItem("acg-city"); } catch (e) {}
  const fromHash = location.hash.slice(1);
  city = [fromHash, saved].find(c => codes.includes(c))
    || codes.find(c => EVENTS.some(e => e.city === c)) || codes[0];
  renderCityTabs();
  window.addEventListener("hashchange", () => {
    const c = location.hash.slice(1);
    if (codes.includes(c) && c !== city) switchCity(c);
  });
}

function renderCityTabs() {
  $("city-tabs").innerHTML = Object.entries(META.cities).map(([k, v]) => {
    const n = EVENTS.filter(e => e.city === k && shown(e)).length;
    const tip = [v.updated && `更新於 ${v.updated}`, v.coveredUntil && `資料查到 ${v.coveredUntil}`].filter(Boolean).join("，");
    return `<button type="button" role="tab" class="city-tab" id="tab-${k}" data-city="${k}" aria-selected="${k === city}" tabindex="${k === city ? 0 : -1}" title="${esc(tip)}">${esc(v.label)}<span class="n">${n}</span></button>`;
  }).join("");
  $("city-tabs").querySelectorAll(".city-tab").forEach(b => b.onclick = () => switchCity(b.dataset.city));
}

function switchCity(c) {
  city = c;
  try { localStorage.setItem("acg-city", c); } catch (e) {}
  if (location.hash.slice(1) !== c) history.replaceState(null, "", `#${c}`);
  filter.place.clear();
  sel = null;
  renderCityTabs();
  renderPlaceChips();
  render();
  $(`tab-${c}`)?.focus({ preventScroll: true });
}

/* ---------- 篩選 ---------- */

const shown = e => !hideEnded || d(e.end) >= today;

function chips(rowId, dict, key, withDot) {
  const row = $(rowId);
  row.querySelectorAll(".chip").forEach(c => c.remove());
  Object.entries(dict).forEach(([k, v]) => {
    const b = document.createElement("button");
    b.className = "chip"; b.type = "button"; b.id = `chip-${key}-${k}`;
    b.setAttribute("aria-pressed", filter[key].has(k));
    if (withDot) b.style.setProperty("--c", TYPE_COLOR[k] || "var(--muted)");
    b.innerHTML = (withDot ? '<span class="dot"></span>' : "") + esc(v.label);
    b.onclick = () => {
      filter[key].has(k) ? filter[key].delete(k) : filter[key].add(k);
      b.setAttribute("aria-pressed", filter[key].has(k));
      render();
    };
    row.appendChild(b);
  });
  updateFade(row);
}

// 地點只列出「已選縣市」且有活動的
function renderPlaceChips() {
  const used = new Set(EVENTS.filter(e => e.city === city && shown(e)).map(e => e.place));
  [...filter.place].forEach(p => { if (!used.has(p)) filter.place.delete(p); });
  chips("f-place", Object.fromEntries(Object.entries(PLACES).filter(([k]) => used.has(k))), "place", false);
}

function visible() {
  return EVENTS
    .filter(e => e.city === city && shown(e)
              && (!filter.type.size || filter.type.has(e.type))
              && (!filter.place.size || filter.place.has(e.place)))
    .sort((a, b) => d(a.start) - d(b.start) || d(a.end) - d(b.end));
}

/* ---------- 時間軸 ---------- */

const x = dt => (dt - T0) / DAY * ppd;

function renderTimeline(list) {
  const width = Math.round(x(T1));
  const months = [];
  for (let m = new Date(T0); m < T1; m = addMonths(m, 1)) months.push(m);
  const quarters = months.filter(m => m.getMonth() % 3 === 0 || +m === +T0);

  const monthPx = 30 * ppd;
  const mLabel = m => monthPx >= 70 ? `${m.getMonth() + 1}月` : monthPx >= 24 ? `${m.getMonth() + 1}` : "";

  let h = `<div class="tl-row tl-q"><div class="tl-name"></div><div class="tl-track" style="width:${width}px">${
    quarters.map((q, i) => {
      const end = quarters[i + 1] || T1;
      const odd = Math.floor(q.getMonth() / 3) % 2;
      return `<div class="q-band${odd ? " alt" : ""}" style="left:${x(q)}px;width:${x(end) - x(q)}px"><span>${quarterOf(q)}</span></div>`;
    }).join("")}</div></div>`;
  h += `<div class="tl-row tl-m"><div class="tl-name">活動</div><div class="tl-track" style="width:${width}px">${
    months.map(m => `<div class="m-tick${m.getMonth() % 3 === 0 ? " q-start" : ""}" style="left:${x(m)}px">${mLabel(m)}</div>`).join("")}</div></div>`;

  // 日：每天的格線（夠寬時）、週六日底色（夠寬時）、日期列（放大到看得清楚時）
  const days = [];
  for (let t = new Date(T0); t < T1; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) days.push(t);
  const showWeekend = ppd >= DAY_LEVEL.weekend, showDayLines = ppd >= DAY_LEVEL.lines, showDayRow = ppd >= DAY_LEVEL.row;
  const weekend = !showWeekend ? "" : days.filter(t => t.getDay() === 0 || t.getDay() === 6)
    .map(t => `<b class="wk${t.getDay() === 0 ? " sun" : ""}" style="left:${x(t)}px;width:${ppd}px"></b>`).join("");
  const dayLines = !showDayLines ? "" : days.filter(t => t.getDate() !== 1).map(t => `<i class="d-line" style="left:${x(t)}px"></i>`).join("");
  if (showDayRow) {
    const wd = ppd >= DAY_LEVEL.weekday;
    h += `<div class="tl-row tl-d"><div class="tl-name"></div><div class="tl-track" style="width:${width}px">${
      days.map(t => {
        const w = t.getDay(), cls = w === 6 ? " sat" : w === 0 ? " sun" : "";
        return `<div class="d-cell${cls}${+t === +today ? " today" : ""}" style="left:${x(t)}px;width:${ppd}px">${t.getDate()}${wd ? `<small>${"日一二三四五六"[w]}</small>` : ""}</div>`;
      }).join("")}</div></div>`;
  }

  const grid = weekend + dayLines + months.map(m => `<i class="${m.getMonth() % 3 === 0 ? "q-line" : ""}" style="left:${x(m)}px"></i>`).join("");
  // AI 查詢涵蓋到的日期：之後的活動可能還沒查，畫一條界線並把後面淡化
  const cov = META.cities[city]?.coveredUntil ? new Date(d(META.cities[city].coveredUntil).getTime() + DAY) : null;
  const covLine = cov && cov > T0 && cov < T1
    ? `<div class="t-covered" style="left:${x(cov)}px;width:${Math.max(0, x(T1) - x(cov))}px"><span>資料查到 ${md(new Date(cov - DAY))}</span></div>` : "";
  const todayLine = today >= T0 && today < T1 ? `<div class="t-today" style="left:${x(today)}px"><span>今天 ${md(today)}</span></div>` : "";

  h += `<div class="tl-body" role="listbox" aria-label="活動"><div class="tl-grid" style="width:${width}px">${grid}${covLine}${todayLine}</div>`;
  if (!list.length) h += `<div class="tl-row"><div class="tl-name muted">沒有符合的活動</div><div class="tl-track" style="width:${width}px"></div></div>`;
  list.forEach(e => {
    const s = d(e.start), en = new Date(d(e.end).getTime() + DAY);
    const range = e.start === e.end ? md(s) : `${md(s)}–${md(d(e.end))}`;
    const cityLabel = META.cities[e.city]?.label || "";
    const on = e === sel;
    // 日期字放得進橫條就放裡面，放不下就放在橫條右邊
    const bw = Math.max(6, x(en) - x(s)), inside = bw >= range.length * 6.6 + 12;
    h += `<div class="tl-row${on ? " selected" : ""}" data-i="${EVENTS.indexOf(e)}" style="--c:${TYPE_COLOR[e.type]}" title="${esc(`${cityLabel} ${e.title}  ${range}`)}">
      <div class="tl-name" tabindex="${on ? 0 : -1}" role="option" aria-selected="${on}"><span class="c-tag p-tag">${esc(PLACES[e.place]?.label || e.place)}</span><span class="t-title">${esc(e.title)}</span></div>
      <div class="tl-track" style="width:${width}px">
        <div class="bar" style="left:${x(s)}px;width:${bw}px">
          <span>${inside ? range : ""}</span></div>${inside ? "" : `<span class="bar-out" style="left:${x(s) + bw + 4}px">${range}</span>`}
      </div></div>`;
  });
  // 填滿剩下的高度：名稱欄底色、格線、週末底色一路延伸到底
  h += `<div class="tl-row tl-fill" aria-hidden="true"><div class="tl-name"></div><div class="tl-track" style="width:${width}px"></div></div>`;
  h += `</div>`;
  $("tl-inner").innerHTML = h;
  $("tl-inner").style.width = `${width + NAME_W()}px`;
}

/* ---------- 縮放 ---------- */

function setupZoom() {
  const sc = $("tl-scroll");
  $("z-in").onclick = () => zoomBy(1.5);
  $("z-out").onclick = () => zoomBy(1 / 1.5);
  document.querySelectorAll(".zpreset").forEach(b => b.onclick = () => zoomToMonths(+b.dataset.months, leftDate()));
  $("z-today").onclick = () => scrollToDate(VIEW0);
  const he = $("hide-ended");
  he.setAttribute("aria-pressed", hideEnded);
  he.onclick = () => {
    hideEnded = !hideEnded;
    he.setAttribute("aria-pressed", hideEnded);
    try { localStorage.setItem("acg-hide-ended", hideEnded ? "1" : "0"); } catch (e) {}
    renderCityTabs();
    renderPlaceChips();
    render();
  };
  sc.addEventListener("wheel", ev => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    const rect = sc.getBoundingClientRect();
    zoomBy(ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.clientX - rect.left);
  }, { passive: false });
  window.addEventListener("resize", () => { const L = leftDate(); render(); scrollToDate(L); });
  setupDrag(sc);
}

// 滑鼠拖曳平移時間軸（左右移動時間、上下捲動活動；觸控螢幕用原生滑動即可）；拖超過 4px 就不觸發點擊
function setupDrag(sc) {
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, moved = false, active = false;
  sc.addEventListener("pointerdown", ev => {
    if (ev.pointerType !== "mouse" || ev.button !== 0) return;
    active = true; moved = false;
    startX = ev.clientX; startY = ev.clientY; startLeft = sc.scrollLeft; startTop = sc.scrollTop;
  });
  window.addEventListener("pointermove", ev => {
    if (!active) return;
    const dx = ev.clientX - startX, dy = ev.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 4) { moved = true; sc.classList.add("dragging"); }
    if (moved) { sc.scrollLeft = startLeft - dx; sc.scrollTop = startTop - dy; ev.preventDefault(); }
  });
  window.addEventListener("pointerup", () => {
    if (!active) return;
    active = false;
    sc.classList.remove("dragging");
  });
  sc.addEventListener("click", ev => { if (moved) { ev.preventDefault(); ev.stopPropagation(); moved = false; } }, true);
  sc.addEventListener("dragstart", ev => ev.preventDefault());
}

const trackViewW = () => Math.max(100, $("tl-scroll").clientWidth - NAME_W());
const leftDate = () => new Date(T0.getTime() + $("tl-scroll").scrollLeft / ppd * DAY);

function scrollToDate(dt) { $("tl-scroll").scrollLeft = Math.max(0, x(dt)); }

function zoomToMonths(n, from) {
  const days = (addMonths(from, n) - from) / DAY;
  ppd = Math.min(MAX_PPD, Math.max(MIN_PPD, trackViewW() / days));
  markPreset(n);
  render();
  scrollToDate(from);
}

// 以畫面上某個 px 位置為中心縮放（預設是時間軸可視區正中央）
function zoomBy(f, anchorPx) {
  const sc = $("tl-scroll");
  const ax = anchorPx === undefined ? NAME_W() + trackViewW() / 2 : anchorPx;
  const anchorDate = new Date(T0.getTime() + (sc.scrollLeft + ax - NAME_W()) / ppd * DAY);
  ppd = Math.min(MAX_PPD, Math.max(MIN_PPD, ppd * f));
  markPreset(null);
  render();
  sc.scrollLeft = Math.max(0, x(anchorDate) - (ax - NAME_W()));
}

function markPreset(n) {
  document.querySelectorAll(".zpreset").forEach(b => b.setAttribute("aria-pressed", +b.dataset.months === n));
}

/* ---------- 選取 ---------- */

// 預設選「今天進行中、最早結束」的活動；沒有就選下一個要開始的
function defaultSelection(list) {
  const ongoing = list.filter(e => d(e.start) <= today && d(e.end) >= today).sort((a, b) => d(a.end) - d(b.end));
  return ongoing[0] || list.find(e => d(e.start) > today) || list[0] || null;
}

function select(e, { focus = false, reveal = true } = {}) {
  sel = e;
  render();
  if (!e) return;
  const row = document.querySelector(`.tl-row[data-i="${EVENTS.indexOf(e)}"]`);
  if (focus) row?.querySelector(".tl-name")?.focus({ preventScroll: true });
  if (row) revealRow(row);
  if (reveal) revealBar(e);
}

// 選取的列在時間軸上下範圍外時，捲到看得到它（扣掉固定在上方的標頭列）
function revealRow(row) {
  const sc = $("tl-scroll");
  const head = [...document.querySelectorAll(".tl-q, .tl-m, .tl-d")].reduce((n, r) => n + r.offsetHeight, 0);
  const top = row.offsetTop, bottom = top + row.offsetHeight;
  if (top - head < sc.scrollTop) sc.scrollTop = top - head;
  else if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight;
}

// 橫條不在可視範圍時，把時間軸捲到看得到它
function revealBar(e) {
  const sc = $("tl-scroll"), view = trackViewW();
  const s = x(d(e.start)), en = x(new Date(d(e.end).getTime() + DAY));
  const L = sc.scrollLeft;
  if (en < L + 16 || s > L + view - 16) sc.scrollLeft = Math.max(0, s - 24);
}

function setupSelect() {
  const inner = $("tl-inner");
  inner.addEventListener("click", ev => {
    const row = ev.target.closest(".tl-body .tl-row[data-i]");
    if (row) select(EVENTS[+row.dataset.i], { focus: true, reveal: !ev.target.closest(".bar") });
  });
  inner.addEventListener("keydown", ev => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key) || !LIST.length) return;
    ev.preventDefault();
    step({ ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[ev.key]);
  });
}

function step(n) {
  const i = LIST.indexOf(sel);
  const j = Math.max(0, Math.min(LIST.length - 1, (i < 0 ? 0 : i) + n));
  select(LIST[j], { focus: true });
}

/* ---------- 繪製 ---------- */

function render() {
  LIST = visible();
  if (!LIST.includes(sel)) sel = defaultSelection(LIST);
  renderTimeline(LIST);
  renderInspector(sel);
  const cm = META.cities[city] || {};
  $("city-meta").innerHTML = [cm.updated && `更新於 <b>${esc(cm.updated)}</b>`, cm.coveredUntil && `資料查到 <b>${esc(cm.coveredUntil)}</b>`]
    .filter(Boolean).join('<span class="sep">·</span>');
  updateMap();
}

const fmt = dt => `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()}（${"日一二三四五六"[dt.getDay()]}）`;

function status(e) {
  const s = d(e.start), en = d(e.end);
  if (today < s) return `<b>${Math.round((s - today) / DAY)} 天後開始</b>`;
  if (today > en) return "已結束";
  const left = Math.round((en - today) / DAY);
  return `<b>進行中</b> · ${left === 0 ? "今天最後一天" : `還剩 ${left + 1} 天`}`;
}

function renderInspector(e) {
  const box = $("insp-body");
  if (!e) { box.innerHTML = `<div class="i-empty">沒有符合的活動。取消一些篩選條件試試。</div>`; return; }
  const s = d(e.start), en = d(e.end), days = Math.round((en - s) / DAY) + 1;
  const P = PLACES[e.place] || { label: e.place, mrt: "", addr: "" };
  const map = P.addr ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(P.addr)}` : "";
  const prop = (k, v) => `<div class="prop"><dt>${k}</dt><dd>${v}</dd></div>`;
  const list = (items, cls = "") => `<ul class="i-list${cls}">${items.map(t => `<li>${esc(t)}</li>`).join("")}</ul>`;
  const works = e.works || [], hls = e.highlights || [];
  const nWorks = works.filter(w => !w.startsWith("等 ")).length;

  const keepTop = box.dataset.ev === String(EVENTS.indexOf(e)) ? $("i-scroll")?.scrollTop || 0 : 0;
  box.dataset.ev = EVENTS.indexOf(e);
  box.style.setProperty("--c", TYPE_COLOR[e.type]);
  // 密集版：不分區塊、不收合，一張屬性表從日期一路排到作品
  box.innerHTML = `
    <div class="i-tab"><span>資訊</span></div>
    <div class="i-head">
      <span class="i-type"><span class="dot"></span>${esc(META.types[e.type]?.label || e.type)}</span>
      <h2>${esc(e.title)}</h2>
      <span class="i-status">${status(e)}</span>
    </div>
    <div class="i-scroll" id="i-scroll">
      <dl class="props">
        ${prop("日期", `<span class="num${e.startUnknown ? " unknown" : ""}"${e.startUnknown ? ' title="開始日不明（報導只寫「即日起」）"' : ""}>${fmt(s)}</span><span class="num"> → ${fmt(en)}</span><span class="sep">·</span><span class="num">${days}</span> 天`)}
        ${prop("位置", `<span class="loc">${esc(e.spot)}${mrtBadges(P.mrt, e.city)}${
          P.addr ? (map ? `<a href="${map}" target="_blank" rel="noopener">${esc(P.addr)} ↗</a>` : `<span>${esc(P.addr)}</span>`) : ""}</span>`)}
        ${prop("連結", `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a>`)}
        ${hls.length ? prop("特色", list(hls, " hl")) : ""}
        ${works.length ? prop(`作品<span class="n">${nWorks}</span>`, list(works)) : ""}
      </dl>
    </div>
  `;
  $("i-scroll").scrollTop = keepTop;
}

// 捷運站號依路線上色；「R10/O5」這種轉乘站拆成多個標籤。同一個代號在不同縣市是不同路線（台北 R 是淡水信義線、高雄 R 是紅線）
const MRT_LINES = {
  taipei:    { BR: ["#C48C31", "文湖線"], R: ["#E3002C", "淡水信義線"], G: ["#008659", "松山新店線"], O: ["#F8B61C", "中和新蘆線", "#1A2038"],
               BL: ["#0070BD", "板南線"], Y: ["#FFDB00", "環狀線", "#1A2038"], A: ["#8246AF", "機場捷運"] },
  kaohsiung: { R: ["#E20B65", "紅線"], O: ["#FAA73F", "橘線", "#1A2038"], C: ["#7CBD52", "環狀輕軌", "#1A2038"] },
  taichung:  { G: ["#8EC31F", "綠線", "#1A2038"] },
};
function mrtBadges(code, cityCode) {
  if (!code) return "";
  return code.split("/").map(c => {
    const line = (c.match(/^[A-Z]+/) || [""])[0];
    const [bg, name, fg = "#FFFFFF"] = MRT_LINES[cityCode]?.[line] || [];
    return bg
      ? `<span class="mrt mrt-line" style="--mrt:${bg};--mrt-fg:${fg}" title="${name}">${esc(c)}</span>`
      : `<span class="mrt">${esc(c)}</span>`;
  }).join("");
}

/* ---------- 地圖（Leaflet + Esri 灰階畫布底圖） ---------- */
// 只顯示目前縣市、通過類型與「隱藏已結束」篩選的活動所在的地點；點標記等於篩選該地點。

let MAP = null, mapLayer = null, mapCity = null;

function initMap() {
  if (!window.L || !$("map")) return;              // CDN 載不到時就不顯示地圖
  MAP = L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: "center" });
  // Esri 灰階畫布底圖（極簡、免金鑰）：淺色／深色各一套，跟著系統主題切換
  const dark = matchMedia("(prefers-color-scheme: dark)");
  let tiles = null;
  const setTiles = () => {
    tiles?.remove();
    const style = dark.matches ? "World_Dark_Gray_Base" : "World_Light_Gray_Base";
    tiles = L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${style}/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 16, attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    }).addTo(MAP);
  };
  setTiles();
  dark.addEventListener?.("change", setTiles);
  // 大眾運輸路線（台鐵、高鐵、捷運、輕軌）：OpenRailwayMap 透明圖層，免費、免金鑰，固定疊在底圖上
  L.tileLayer("https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png", {
    subdomains: "abc", maxZoom: 19, opacity: 0.75, className: "map-rail",
    attribution: '&copy; <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>',
  }).addTo(MAP);
  mapLayer = L.layerGroup().addTo(MAP);

  // 地圖可收合（預設展開），狀態記在瀏覽器
  let collapsed = false;
  try { collapsed = localStorage.getItem("acg-map-collapsed") === "1"; } catch (e) {}
  const head = $("map-head");
  const apply = () => {
    $("map").hidden = collapsed;
    head.setAttribute("aria-expanded", !collapsed);
    if (!collapsed) setTimeout(() => { MAP.invalidateSize(); fitCity(); }, 0);
  };
  head.onclick = () => {
    collapsed = !collapsed;
    try { localStorage.setItem("acg-map-collapsed", collapsed ? "1" : "0"); } catch (e) {}
    apply();
  };
  apply();
  new ResizeObserver(() => MAP.invalidateSize()).observe($("map"));
}

// 目前縣市（不含地點篩選）看得到的活動，依地點分組
function mapGroups() {
  const groups = new Map();
  EVENTS.filter(e => e.city === city && shown(e) && (!filter.type.size || filter.type.has(e.type)))
    .forEach(e => { if (!groups.has(e.place)) groups.set(e.place, []); groups.get(e.place).push(e); });
  return groups;
}

function fitCity() {
  if (!MAP) return;
  const pts = [...mapGroups().keys()].map(k => PLACES[k]).filter(p => p?.lat).map(p => [p.lat, p.lng]);
  if (pts.length > 1) MAP.fitBounds(pts, { padding: [24, 24], maxZoom: 14 });
  else if (pts.length === 1) MAP.setView(pts[0], 14);
  else if (META.cities[city]?.center) MAP.setView(META.cities[city].center, 12);
}

function updateMap() {
  if (!MAP) return;
  mapLayer.clearLayers();
  const groups = mapGroups();
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim(), ink = css.getPropertyValue("--ink").trim(), bg = css.getPropertyValue("--surface").trim();
  groups.forEach((evs, k) => {
    const p = PLACES[k];
    if (!p?.lat) return;
    const isSel = sel?.place === k, isFiltered = filter.place.has(k);
    const m = L.circleMarker([p.lat, p.lng], {
      radius: 6 + Math.min(8, evs.length * 1.5) + (isSel ? 3 : 0),
      color: isSel || isFiltered ? ink : bg, weight: isSel ? 3 : 2,
      fillColor: accent, fillOpacity: filter.place.size && !isFiltered ? 0.35 : 0.9,
    }).addTo(mapLayer);
    m.bindTooltip(`<b>${esc(p.label)}</b> · ${evs.length} 檔`, { direction: "top", offset: [0, -6], permanent: isSel, className: "map-tip" });
    m.on("click", () => {
      filter.place.has(k) && filter.place.size === 1 ? filter.place.clear() : (filter.place.clear(), filter.place.add(k));
      document.querySelectorAll("#f-place .chip").forEach(c => c.setAttribute("aria-pressed", filter.place.has(c.id.replace("chip-place-", ""))));
      render();
    });
  });
  if (mapCity !== city) { mapCity = city; fitCity(); }
  else if (sel && PLACES[sel.place]?.lat && !MAP.getBounds().contains([PLACES[sel.place].lat, PLACES[sel.place].lng])) {
    MAP.panTo([PLACES[sel.place].lat, PLACES[sel.place].lng]);
  }
}

/* ---------- 左右面板寬度（拖曳條） ---------- */

const INSP_MIN = 260, MAIN_MIN = 420;

function setupSplitter() {
  const sp = $("splitter"), ws = document.querySelector(".workspace");
  if (!sp) return;
  const clamp = w => Math.round(Math.max(INSP_MIN, Math.min(ws.clientWidth - sp.offsetWidth - MAIN_MIN, w)));
  const apply = w => {
    w = clamp(w);
    ws.style.setProperty("--insp-w", `${w}px`);
    sp.setAttribute("aria-valuenow", w);
    return w;
  };
  let saved = 340;
  try { saved = +localStorage.getItem("acg-insp-w") || 340; } catch (e) {}
  apply(saved);
  const save = w => { try { localStorage.setItem("acg-insp-w", w); } catch (e) {} };

  sp.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    sp.setPointerCapture(ev.pointerId);
    sp.classList.add("dragging"); document.body.classList.add("resizing");
    const right = ws.getBoundingClientRect().right;
    const move = e => apply(right - e.clientX - sp.offsetWidth / 2);
    const up = () => {
      sp.removeEventListener("pointermove", move);
      sp.classList.remove("dragging"); document.body.classList.remove("resizing");
      save(parseInt(getComputedStyle(ws).getPropertyValue("--insp-w")));
    };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", up, { once: true });
    sp.addEventListener("pointercancel", up, { once: true });
  });
  // 鍵盤：左右鍵每次 20px
  sp.addEventListener("keydown", ev => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const cur = parseInt(getComputedStyle(ws).getPropertyValue("--insp-w")) || 340;
    save(apply(cur + (ev.key === "ArrowLeft" ? 20 : -20)));
  });
  // 雙擊恢復預設寬度
  sp.addEventListener("dblclick", () => save(apply(340)));
  window.addEventListener("resize", () => apply(parseInt(getComputedStyle(ws).getPropertyValue("--insp-w")) || 340));
}

/* ---------- 地圖高度（地圖上緣的拖曳條，往上拖地圖變高） ---------- */

const MAP_MIN = 120, MAP_DEFAULT = 220, INSP_BODY_MIN = 160;

function setupMapSplit() {
  const sp = $("map-split"), map = $("map"), insp = $("inspector");
  if (!sp || !map) return;
  const clamp = h => Math.round(Math.max(MAP_MIN, Math.min(insp.clientHeight - INSP_BODY_MIN - 40, h)));
  const cur = () => map.getBoundingClientRect().height || MAP_DEFAULT;
  const apply = h => { h = clamp(h); insp.style.setProperty("--map-h", `${h}px`); sp.setAttribute("aria-valuenow", h); return h; };
  const save = h => { try { localStorage.setItem("acg-map-h", h); } catch (e) {} };
  let saved = MAP_DEFAULT;
  try { saved = +localStorage.getItem("acg-map-h") || MAP_DEFAULT; } catch (e) {}
  apply(saved);

  sp.addEventListener("pointerdown", ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    sp.setPointerCapture(ev.pointerId);
    sp.classList.add("dragging"); document.body.classList.add("resizing-v");
    const bottom = map.getBoundingClientRect().bottom;
    const move = e => apply(bottom - e.clientY);
    const up = () => {
      sp.removeEventListener("pointermove", move);
      sp.classList.remove("dragging"); document.body.classList.remove("resizing-v");
      save(cur());
    };
    sp.addEventListener("pointermove", move);
    sp.addEventListener("pointerup", up, { once: true });
    sp.addEventListener("pointercancel", up, { once: true });
  });
  sp.addEventListener("keydown", ev => {
    if (ev.key !== "ArrowUp" && ev.key !== "ArrowDown") return;
    ev.preventDefault();
    save(apply(cur() + (ev.key === "ArrowUp" ? 20 : -20)));
  });
  sp.addEventListener("dblclick", () => save(apply(MAP_DEFAULT)));
  window.addEventListener("resize", () => apply(cur()));
}

/* ---------- 類型／地點橫向捲動 ---------- */

function updateFade(el) {
  const max = el.scrollWidth - el.clientWidth;
  el.classList.toggle("fade-l", el.scrollLeft > 2);
  el.classList.toggle("fade-r", max - el.scrollLeft > 2);
}

function setupFilterScroll() {
  document.querySelectorAll(".fscroll").forEach(el => {
    el.addEventListener("scroll", () => updateFade(el), { passive: true });
    // 一般滾輪（上下）直接轉成左右捲動
    el.addEventListener("wheel", ev => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return;
      ev.preventDefault();
      el.scrollLeft += ev.deltaY;
    }, { passive: false });
    // 滑鼠拖曳；拖超過 4px 就不觸發按鈕
    let x0 = 0, left0 = 0, active = false, moved = false;
    el.addEventListener("pointerdown", ev => {
      if (ev.pointerType !== "mouse" || ev.button !== 0) return;
      active = true; moved = false; x0 = ev.clientX; left0 = el.scrollLeft;
    });
    window.addEventListener("pointermove", ev => {
      if (!active) return;
      const dx = ev.clientX - x0;
      if (!moved && Math.abs(dx) > 4) { moved = true; el.classList.add("dragging"); }
      if (moved) el.scrollLeft = left0 - dx;
    });
    window.addEventListener("pointerup", () => { active = false; el.classList.remove("dragging"); });
    el.addEventListener("click", ev => { if (moved) { ev.preventDefault(); ev.stopPropagation(); moved = false; } }, true);
    new ResizeObserver(() => updateFade(el)).observe(el);
  });
}

/* ---------- 關於網站（地圖下方，預設收起） ---------- */

function renderAbout() {
  $("about-body").innerHTML = `
    <p>日本動漫展覽、快閃店、主題餐廳與同人活動檔期。</p>
    <p class="about-note"><b>資料由 AI 整理，可能不正確</b>，請以官方公告為準。</p>
    <p class="about-credit">地圖：Leaflet · Esri · OpenStreetMap · OpenRailwayMap</p>
  `;
}

/* ---------- 資訊、關於網站：滑鼠也能拖曳捲動（觸控用原生滑動） ---------- */

function setupPanelDrag() {
  // 資訊內容每次選活動都會重畫，所以掛在外層，拖曳時再找目前的捲動區
  [["insp-body", "#i-scroll"], ["about-body", null]].forEach(([id, inner]) => {
    const host = $(id);
    if (!host) return;
    let el = null, y0 = 0, top0 = 0, active = false, moved = false;
    host.addEventListener("pointerdown", ev => {
      if (ev.pointerType !== "mouse" || ev.button !== 0) return;
      el = inner ? host.querySelector(inner) : host;
      if (!el || el.scrollHeight <= el.clientHeight) return;
      active = true; moved = false; y0 = ev.clientY; top0 = el.scrollTop;
    });
    window.addEventListener("pointermove", ev => {
      if (!active) return;
      const dy = ev.clientY - y0;
      if (!moved && Math.abs(dy) > 4) { moved = true; host.classList.add("drag-scrolling"); }
      if (moved) { el.scrollTop = top0 - dy; ev.preventDefault(); }
    });
    window.addEventListener("pointerup", () => { active = false; host.classList.remove("drag-scrolling"); });
    host.addEventListener("click", ev => { if (moved) { ev.preventDefault(); ev.stopPropagation(); moved = false; } }, true);
  });
}
