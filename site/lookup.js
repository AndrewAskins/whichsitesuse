// Free domain lookup on the homepage. Checks GET {api}/health for a published snapshot, then calls the
// anonymous, rate-limited GET {api}/v1/public/domains/{domain} and renders the stack. Until the first
// snapshot is published the box shows a "data loading" note instead.
(function () {
  "use strict";

  var api = (document.querySelector('meta[name="wsu-api"]') || {}).content || "";
  var form = document.getElementById("lookup");
  var input = document.getElementById("domain");
  var result = document.getElementById("result");
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

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

  // Browse section: live site counts for the technology tiles, from the same data as the directory pages.
  // The static tiles (name, category, logo) stand on their own if this call fails.
  var tiles = document.getElementById("tech-tiles");
  if (tiles && window.fetch) {
    var cards = Array.prototype.slice.call(tiles.querySelectorAll("a[data-slug]"));
    var slugs = cards.map(function (a) { return a.getAttribute("data-slug"); });
    fetch("/companies-using/technologies.json?slugs=" + encodeURIComponent(slugs.join(",")))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (body) {
        if (!body || !body.technologies) return;
        var bySlug = {};
        body.technologies.forEach(function (t) { bySlug[t.slug] = t; });
        cards.forEach(function (a) {
          var t = bySlug[a.getAttribute("data-slug")];
          if (!t) return;
          var meta = a.querySelector(".seo-card-text span");
          if (meta) meta.textContent = t.sites_label + (t.category ? " · " + t.category : "");
        });
      })
      .catch(function () {});
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

  var base = api.replace(/\/$/, "");
  var LOADING = "We're loading this month's HTTP Archive crawl into the lookup. It opens as soon as the first snapshot is published, so check back shortly. The table on this page already shows real counts from the November 2026 crawl.";
  var UNREACHABLE = "The lookup service isn't answering right now. Try again in a minute.";

  // Ask the API once whether a snapshot is live. null = unknown (network/CORS), true/false = known.
  var ready = null;
  function checkHealth() {
    if (!base || !window.fetch) return Promise.resolve(false);
    return fetch(base + "/health", { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) {
        if (body && body.turnstile_site_key) setUpTurnstile(body.turnstile_site_key);
        ready = body ? Boolean(body.snapshot) : null;
        return ready;
      })
      .catch(function () { ready = null; return null; });
  }
  // Bot check: only when the API says Turnstile is on (/health returns its site key). The widget stays
  // invisible unless Cloudflare needs an interaction; each lookup sends a fresh token and then resets it.
  var turnstileId = null;
  var turnstileWaiters = [];
  function setUpTurnstile(siteKey) {
    var box = el("div", { class: "turnstile-box" });
    form.parentNode.insertBefore(box, form.nextSibling);
    window.onWsuTurnstileLoad = function () {
      turnstileId = window.turnstile.render(box, {
        sitekey: siteKey,
        appearance: "interaction-only",
        callback: function () { turnstileWaiters.splice(0).forEach(function (fn) { fn(); }); },
      });
    };
    var script = el("script", { src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onWsuTurnstileLoad", async: "", defer: "" });
    document.head.appendChild(script);
  }
  function turnstileToken() {
    if (turnstileId === null && !window.onWsuTurnstileLoad) return Promise.resolve(null);
    var current = turnstileId !== null ? window.turnstile.getResponse(turnstileId) : "";
    if (current) return Promise.resolve(current);
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (done) return; done = true; resolve(turnstileId !== null ? window.turnstile.getResponse(turnstileId) || null : null); };
      turnstileWaiters.push(finish);
      setTimeout(finish, 15000);
    });
  }

  var health = checkHealth();
  var status = document.getElementById("lookup-status");
  health.then(function (isReady) {
    if (status && isReady !== true) {
      status.textContent = "Data loading: this month's crawl is being loaded into the lookup, and it opens as soon as that finishes.";
      status.hidden = false;
    }
  });

  function showNotice(message) {
    result.hidden = false;
    result.replaceChildren(el("div", { class: "notice" }, message));
  }

  function bucketLabel(n) {
    if (!n) return null;
    if (n >= 1000000) return "top " + n / 1000000 + "M";
    if (n >= 1000) return "top " + n / 1000 + "k";
    return "top " + n;
  }

  function msLabel(metric, v) {
    if (v == null) return "";
    if (metric === "cls") return " " + Math.round(v * 100) / 100;
    if (metric === "lcp") return " " + Math.round(v / 100) / 10 + " s";
    return " " + Math.round(v) + " ms";
  }

  function render(domain, body) {
    var data = (body && body.data) || {};
    var meta = (body && body.meta) || {};
    if (data.covered === false) {
      showNotice((data.domain || domain) + " isn't in this month's HTTP Archive crawl, usually because it gets too little Chrome traffic. Lookups for sites that aren't covered are always free.");
      return;
    }

    var head = el("div", { class: "result-head" });
    var left = el("span");
    left.appendChild(el("strong", null, data.domain || domain));
    head.appendChild(left);
    head.appendChild(el("span", { class: "muted" }, "crawl: " + (meta.crawl_date || data.last_crawl_date || "latest")));

    var table = el("table");
    var thead = el("thead");
    var hr = el("tr");
    ["Category", "Detected"].forEach(function (h) { hr.appendChild(el("th", { scope: "col" }, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el("tbody");
    (data.stack || []).forEach(function (group) {
      var tr = el("tr");
      tr.appendChild(el("td", null, group.category));
      tr.appendChild(el("td", null, (group.technologies || []).map(function (t) {
        return t.version ? t.name + " " + t.version : t.name;
      }).join(", ")));
      tbody.appendChild(tr);
    });
    if (!tbody.children.length) {
      var empty = el("tr");
      empty.appendChild(el("td", { colspan: "2" }, "No technologies were detected on this site's crawled pages."));
      tbody.appendChild(empty);
    }
    table.appendChild(tbody);
    var wrap = el("div", { class: "table-wrap" });
    wrap.appendChild(table);

    var pills = el("div", { class: "pills" });
    var bucket = bucketLabel(data.rank_bucket);
    if (bucket) pills.appendChild(el("span", { class: "pill" }, bucket));
    var cwv = (data.cwv && data.cwv.mobile) || {};
    ["lcp", "inp", "cls"].forEach(function (m) {
      var v = cwv[m];
      if (!v || v.pass == null) return;
      pills.appendChild(el("span", { class: "pill" + (v.pass ? " pill-pass" : "") }, m.toUpperCase() + msLabel(m, v.p75) + (v.pass ? " pass" : " fail")));
    });

    result.hidden = false;
    result.replaceChildren(head, wrap, pills);
  }

  function lookup(domain) {
    showNotice("Looking up " + domain + "...");
    return turnstileToken().then(function (token) {
      var headers = { Accept: "application/json" };
      if (token) headers["x-turnstile-token"] = token;
      if (turnstileId !== null) window.turnstile.reset(turnstileId);
      return fetch(base + "/v1/public/domains/" + encodeURIComponent(domain), { headers: headers });
    })
      .then(function (res) {
        return res.json().catch(function () { return null; }).then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        var code = r.body && r.body.error && r.body.error.code;
        if (r.res.ok) return render(domain, r.body);
        if (r.res.status === 429) return showNotice("You've run a lot of lookups from your network. Try again in a minute, or sign up for an API key.");
        if (r.res.status === 400 && code === "invalid_input") return showNotice("Enter a domain like example.com.");
        if (r.res.status === 401) return showNotice("We couldn't confirm you're a person. Complete the check under the search box and try again.");
        if (r.res.status === 503 || code === "snapshot_unavailable") { ready = false; return showNotice(LOADING); }
        showNotice(ready === false ? LOADING : UNREACHABLE);
      })
      .catch(function () {
        showNotice(ready === false ? LOADING : UNREACHABLE);
      });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var domain = normalize(input.value);
    if (!domain) {
      showNotice("Enter a domain like example.com.");
      return;
    }
    if (!base) {
      showNotice(LOADING);
      return;
    }
    health.then(function (isReady) {
      if (isReady === false) return showNotice(LOADING);
      lookup(domain);
    });
  });
})();
