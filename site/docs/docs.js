// Docs pages: mark the current page in the sidebar, build the on-page contents from the article's
// headings, highlight the section in view, and add a copy button to every code block.
(function () {
  "use strict";
  var year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  // Sidebar: current page, and collapse the menu on small screens.
  var here = location.pathname.replace(/index\.html$/, "");
  if (here.slice(-1) !== "/") here += "/";
  document.querySelectorAll(".docs-nav a").forEach(function (a) {
    if (a.getAttribute("href") === here) a.setAttribute("aria-current", "page");
  });
  var menu = document.querySelector(".docs-menu");
  if (menu && window.matchMedia("(max-width: 860px)").matches) menu.removeAttribute("open");

  // On this page.
  var article = document.querySelector(".docs-article");
  var toc = document.getElementById("docs-toc");
  var heads = article ? Array.prototype.slice.call(article.querySelectorAll("h2[id], h3[id]")) : [];
  if (toc && heads.length > 1) {
    heads.forEach(function (h) {
      var li = document.createElement("li");
      li.className = "toc-" + h.tagName.toLowerCase();
      var a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      toc.appendChild(li);
    });
    var links = toc.querySelectorAll("a");
    var setActive = function () {
      var current = heads[0];
      heads.forEach(function (h) { if (h.getBoundingClientRect().top < 120) current = h; });
      links.forEach(function (a) { a.classList.toggle("is-active", a.getAttribute("href") === "#" + current.id); });
    };
    window.addEventListener("scroll", setActive, { passive: true });
    setActive();
  } else if (toc) {
    toc.parentNode.hidden = true;
  }

  // Code blocks: header with the language and a copy button.
  document.querySelectorAll(".docs-article pre[data-lang]").forEach(function (pre) {
    var box = document.createElement("div");
    box.className = "code";
    var head = document.createElement("div");
    head.className = "code-head";
    var lang = document.createElement("span");
    lang.textContent = pre.getAttribute("data-lang");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", function () {
      var text = pre.innerText.replace(/\n$/, "");
      var done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
    });
    head.appendChild(lang);
    head.appendChild(btn);
    pre.parentNode.insertBefore(box, pre);
    box.appendChild(head);
    box.appendChild(pre);
  });
})();
