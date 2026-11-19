// Free domain lookup on the homepage. Calls GET {api}/v1/domains/{domain} and renders the stack.
// Until that endpoint is live (or when it fails), the example result stays and a notice explains why.
(function () {
  "use strict";

  var api = (document.querySelector('meta[name="wsu-api"]') || {}).content || "";
  var form = document.getElementById("lookup");
  var input = document.getElementById("domain");
  var result = document.getElementById("result");
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Theme switch: light and dark buttons in the header; the choice is remembered.
  var root = document.documentElement;
  var switches = document.querySelectorAll("[data-set-theme]");
  function effectiveTheme() {
    return root.getAttribute("data-theme") ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function syncSwitch() {
    var t = effectiveTheme();
    for (var k = 0; k < switches.length; k++) {
      switches[k].setAttribute("aria-pressed", String(switches[k].getAttribute("data-set-theme") === t));
    }
  }
  for (var k = 0; k < switches.length; k++) {
    switches[k].addEventListener("click", function () {
      var t = this.getAttribute("data-set-theme");
      root.setAttribute("data-theme", t);
      try { localStorage.setItem("wsu-theme", t); } catch (e) {}
      syncSwitch();
    });
  }
  syncSwitch();

  // H1 "Which sites use [technology]?": cycles through the rows of the adoption table (real HTTP Archive counts).
  // The static Shopify text is what crawlers, no-JS readers and reduced-motion readers see.
  var word = document.getElementById("tech-word");
  var count = document.getElementById("tech-count");
  var rows = Array.prototype.slice.call(document.querySelectorAll("#adoption tbody tr[data-tech]"));
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (word && count && rows.length > 1 && !reduce) {
    var i = 0;
    setInterval(function () {
      word.classList.add("is-swapping");
      count.classList.add("is-swapping");
      setTimeout(function () {
        rows[i].classList.remove("is-current");
        i = (i + 1) % rows.length;
        rows[i].classList.add("is-current");
        word.textContent = rows[i].getAttribute("data-tech");
        count.textContent = rows[i].children[1].textContent;
        word.classList.remove("is-swapping");
        count.classList.remove("is-swapping");
      }, 180);
    }, 2400);
  }
  if (!form || !input || !result) return;

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (text != null) node.textContent = text;
    return node;
  }

  // Accept "https://www.example.com/path" and similar; keep only the host.
  function normalize(raw) {
    var s = String(raw || "").trim().toLowerCase();
    s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
    s = s.split(/[\/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
    return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(s) ? s : null;
  }

  var PRELAUNCH = "Free lookups open when WhichSitesUse launches. Until then, the table below shows real counts from HTTP Archive's latest crawl.";

  function showNotice(message) {
    result.hidden = false;
    result.replaceChildren(el("div", { class: "notice" }, message));
  }

  function render(domain, body) {
    var data = (body && body.data) || {};
    var meta = (body && body.meta) || {};
    if (data.covered === false) {
      showNotice(domain + " isn't in the latest HTTP Archive crawl, usually because it gets too little Chrome traffic. Not covered lookups are always free.");
      return;
    }

    var head = el("div", { class: "result-head" });
    var left = el("span");
    left.appendChild(el("strong", null, data.domain || domain));
    head.appendChild(left);
    head.appendChild(el("span", { class: "muted" }, "crawl: " + (meta.crawl_date || data.crawl_date || "latest")));

    var table = el("table");
    var thead = el("thead");
    var hr = el("tr");
    ["Category", "Detected", "Version"].forEach(function (h) { hr.appendChild(el("th", { scope: "col" }, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el("tbody");

    // Accept either { categories: [{ name, technologies: [{ name, version }] }] } or a flat technologies list.
    var groups = data.categories;
    if (!Array.isArray(groups) && Array.isArray(data.technologies)) {
      var byCat = {};
      data.technologies.forEach(function (t) {
        var cat = (t.categories && t.categories[0]) || t.category || "Other";
        (byCat[cat] = byCat[cat] || []).push(t);
      });
      groups = Object.keys(byCat).map(function (name) { return { name: name, technologies: byCat[name] }; });
    }
    (groups || []).forEach(function (g) {
      var techs = g.technologies || [];
      var tr = el("tr");
      tr.appendChild(el("td", null, g.name || g.category || ""));
      tr.appendChild(el("td", null, techs.map(function (t) { return t.name || t.technology; }).join(", ")));
      tr.appendChild(el("td", null, techs.map(function (t) { return t.version; }).filter(Boolean).join(", ")));
      tbody.appendChild(tr);
    });
    if (!tbody.children.length) {
      var empty = el("tr");
      empty.appendChild(el("td", { colspan: "3" }, "No technologies detected on this site's crawled pages."));
      tbody.appendChild(empty);
    }
    table.appendChild(tbody);
    var wrap = el("div", { class: "table-wrap" });
    wrap.appendChild(table);

    var pills = el("div", { class: "pills" });
    if (data.rank_bucket) pills.appendChild(el("span", { class: "pill" }, "top " + data.rank_bucket));
    var cwv = data.cwv || data.core_web_vitals || {};
    ["lcp", "inp", "cls"].forEach(function (m) {
      var v = cwv[m];
      if (v == null) return;
      var pass = v === true || v === "pass" || v === "passing";
      pills.appendChild(el("span", { class: "pill" + (pass ? " pill-pass" : "") }, m.toUpperCase() + (pass ? " pass" : " fail")));
    });

    result.hidden = false;
    result.replaceChildren(head, wrap, pills);
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var domain = normalize(input.value);
    if (!domain) {
      showNotice("Enter a domain like example.com.");
      return;
    }
    if (!api) {
      showNotice(PRELAUNCH);
      return;
    }
    showNotice("Looking up " + domain + "...");
    fetch(api.replace(/\/$/, "") + "/v1/domains/" + encodeURIComponent(domain), { headers: { Accept: "application/json" } })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        if (r.res.ok) return render(domain, r.body);
        if (r.res.status === 404) return render(domain, { data: { covered: false } });
        if (r.res.status === 429) return showNotice("Too many lookups from your network. Try again in a minute.");
        showNotice(PRELAUNCH);
      })
      .catch(function () {
        showNotice(PRELAUNCH);
      });
  });
})();
