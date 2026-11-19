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

  var exampleHTML = result.innerHTML;
  var PRELAUNCH = "Free lookups open when WhichSitesUse launches. The example below shows what a result looks like.";

  function showNotice(message, withExample) {
    if (withExample) result.innerHTML = exampleHTML;
    else result.replaceChildren();
    var note = el("div", { class: "notice" }, message);
    if (withExample) note.style.marginBottom = "16px";
    result.insertBefore(note, result.firstChild);
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
      showNotice(PRELAUNCH, true);
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
        showNotice(PRELAUNCH, true);
      })
      .catch(function () {
        showNotice(PRELAUNCH, true);
      });
  });
})();
