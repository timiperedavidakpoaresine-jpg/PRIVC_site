(function () {
  "use strict";

  var STORAGE_KEY = "atlasReports";
  var TYPES = ["Annual report", "Article", "Policy brief", "Technical note"];
  var state = { publicItems: [], localItems: [], errors: [] };
  var loadPromise = null;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeReport(value, defaultStatus) {
    if (!value || typeof value !== "object" || !value.title) return null;
    var legacyFile = value.file && typeof value.file === "object" ? value.file : {};
    var pdf = value.pdf || value.url || legacyFile.data || "";
    var status = value.status === "draft" || value.status === "published"
      ? value.status
      : defaultStatus;
    return {
      id: String(value.id == null ? "" : value.id),
      title: String(value.title).trim(),
      authors: String(value.authors || "").trim(),
      year: Number(value.year) || new Date().getFullYear(),
      type: TYPES.indexOf(value.type) >= 0 ? value.type : "Article",
      summary: String(value.summary || "").trim(),
      tags: Array.isArray(value.tags)
        ? value.tags.map(function (tag) { return String(tag).trim(); }).filter(Boolean)
        : String(value.tags || "").split(",").map(function (tag) { return tag.trim(); }).filter(Boolean),
      status: status,
      pdf: String(pdf),
      pdfName: String(value.pdfName || legacyFile.name || ""),
      body: String(value.body || "")
    };
  }

  function parseReportFile(value) {
    var items = Array.isArray(value) ? value : value && Array.isArray(value.reports) ? value.reports : null;
    if (!items) throw new Error("The file must contain a reports array.");
    return items.map(function (item) {
      var report = normalizeReport(item, "published");
      if (!report || !report.id || !report.title) throw new Error("Every report needs an id and title.");
      return report;
    });
  }

  // Keep persistence behind these functions so a remote data source can replace localStorage.
  async function getReports() {
    var errors = [];
    var localItems = [];
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        var parsedLocal = JSON.parse(stored);
        if (!Array.isArray(parsedLocal)) throw new Error("Saved browser reports are not a list.");
        localItems = parsedLocal.map(function (item) { return normalizeReport(item, "draft"); })
          .filter(function (item) { return item && item.id && item.title; });
      }
    } catch (error) {
      errors.push("Browser-only reports could not be read: " + error.message);
    }

    var publicItems = [];
    try {
      var response = await fetch(new URL("reports/reports.json", document.baseURI), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      publicItems = parseReportFile(await response.json());
    } catch (error) {
      errors.push("Public reports could not be loaded: " + error.message);
    }
    return { publicItems: publicItems, localItems: localItems, errors: errors };
  }

  function ensureReportsLoaded() {
    if (!loadPromise) {
      loadPromise = getReports().then(function (result) {
        state = result;
        return result;
      });
    }
    return loadPromise;
  }

  async function saveReport(value) {
    var report = normalizeReport(value, "draft");
    if (!report || !report.id || !report.title) throw new Error("A report id and title are required.");
    var previous = state.localItems.slice();
    var index = state.localItems.findIndex(function (item) { return item.id === report.id; });
    if (index < 0) state.localItems.push(report);
    else state.localItems[index] = report;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.localItems));
    } catch (error) {
      state.localItems = previous;
      throw error;
    }
    return report;
  }

  async function deleteReport(id) {
    var previous = state.localItems.slice();
    state.localItems = state.localItems.filter(function (item) { return item.id !== String(id); });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.localItems));
    } catch (error) {
      state.localItems = previous;
      throw error;
    }
  }

  window.reportsData = { getReports: getReports, saveReport: saveReport, deleteReport: deleteReport };

  function mergedReports() {
    var byId = new Map();
    state.publicItems.forEach(function (item) { byId.set(item.id, Object.assign({ source: "public" }, item)); });
    state.localItems.forEach(function (item) { byId.set(item.id, Object.assign({ source: "local" }, item)); });
    return Array.from(byId.values());
  }

  function pdfUrl(report) {
    if (!report.pdf) return "";
    if (/^data:application\/pdf;base64,/i.test(report.pdf)) return report.pdf;
    try {
      var url = new URL(report.pdf, document.baseURI);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function currentHashId() {
    var match = location.hash.match(/^#report=(.*)$/);
    if (!match) return "";
    try { return decodeURIComponent(match[1]); }
    catch (error) { return ""; }
  }

  function setStatus(message, isError) {
    var status = document.getElementById("reports-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("reports-error", Boolean(isError));
  }

  function setOperationStatus(message) {
    var details = state.errors.join(" ");
    setStatus(details ? message + " " + details : message, Boolean(details));
  }

  function setOptions(select, values, allLabel) {
    var previous = select.value;
    select.innerHTML = '<option value="">' + escapeHtml(allLabel) + "</option>" +
      values.map(function (value) {
        return '<option value="' + escapeHtml(value) + '">' + escapeHtml(value) + "</option>";
      }).join("");
    if (values.indexOf(previous) >= 0) select.value = previous;
  }

  function renderFilters() {
    var items = mergedReports().filter(function (item) {
      return item.source === "local" || item.status !== "draft";
    });
    setOptions(document.getElementById("reports-year"), Array.from(new Set(items.map(function (item) {
      return String(item.year);
    }))).sort(function (a, b) { return Number(b) - Number(a); }), "All years");
    setOptions(document.getElementById("reports-tag"), Array.from(new Set([].concat.apply([], items.map(function (item) {
      return item.tags;
    })))).sort(function (a, b) { return a.localeCompare(b); }), "All tags");
  }

  function reportCard(report) {
    var tags = report.tags.map(function (tag) {
      return '<span class="report-tag">' + escapeHtml(tag) + "</span>";
    }).join("");
    var localBadge = report.source === "local"
      ? '<span class="report-draft-badge">Draft (this browser only)</span>'
      : "";
    var statusBadge = report.status === "draft"
      ? '<span class="report-status-badge">Draft</span>'
      : "";
    return '<article class="report-card" aria-labelledby="report-title-' + escapeHtml(report.id) + '">' +
      '<div class="report-card-meta"><span class="report-type">' + escapeHtml(report.type) + "</span>" +
      '<span>' + escapeHtml(report.year) + "</span>" + localBadge + statusBadge + "</div>" +
      '<h3 id="report-title-' + escapeHtml(report.id) + '">' + escapeHtml(report.title) + "</h3>" +
      '<p class="report-authors">' + escapeHtml(report.authors || "Author not listed") + "</p>" +
      '<p class="report-summary">' + escapeHtml(report.summary) + "</p>" +
      (tags ? '<div class="report-tags" aria-label="Tags">' + tags + "</div>" : "") +
      '<div class="report-actions">' +
      '<button type="button" data-action="read" data-id="' + escapeHtml(report.id) + '">Read</button>' +
      '<button type="button" data-action="download" data-id="' + escapeHtml(report.id) + '"' +
      (pdfUrl(report) ? "" : " disabled") + '>Download PDF</button>' +
      (report.body ? '<button type="button" data-action="article" data-id="' + escapeHtml(report.id) + '">Download article</button>' : "") +
      '<button type="button" data-action="copy" data-id="' + escapeHtml(report.id) + '">Copy link</button>' +
      (report.source === "local"
        ? '<button type="button" data-action="edit" data-id="' + escapeHtml(report.id) + '">Edit</button>' +
          '<button type="button" data-action="delete" data-id="' + escapeHtml(report.id) + '">Delete</button>'
        : "") +
      "</div></article>";
  }

  function renderList() {
    var query = document.getElementById("reports-search").value.trim().toLocaleLowerCase();
    var type = document.getElementById("reports-type").value;
    var year = document.getElementById("reports-year").value;
    var tag = document.getElementById("reports-tag").value;
    var sort = document.getElementById("reports-sort").value;
    var items = mergedReports().filter(function (item) {
      if (item.source !== "local" && item.status === "draft") return false;
      var haystack = [item.title, item.authors, item.year].concat(item.tags).join(" ").toLocaleLowerCase();
      return (!type || item.type === type) &&
        (!year || String(item.year) === year) &&
        (!tag || item.tags.indexOf(tag) >= 0) &&
        (!query || haystack.indexOf(query) >= 0);
    });
    items.sort(function (a, b) {
      if (sort === "oldest") return a.year - b.year || a.title.localeCompare(b.title);
      if (sort === "title") return a.title.localeCompare(b.title);
      return b.year - a.year || a.title.localeCompare(b.title);
    });
    var results = document.getElementById("reports-results");
    if (!items.length) {
      results.innerHTML = '<div class="reports-empty"><h3>No reports match these filters</h3>' +
        "<p>Try a different search or filter. You can also write a browser-only draft.</p></div>";
    } else {
      results.innerHTML = items.map(reportCard).join("");
    }
  }

  function bodyMarkup(body) {
    return String(body || "").trim().split(/\n\s*\n/).filter(Boolean).map(function (paragraph) {
      return "<p>" + escapeHtml(paragraph).replace(/\n/g, "<br>") + "</p>";
    }).join("");
  }

  function downloadArticle(report) {
    var html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>' + escapeHtml(report.title) +
      '</title><body style="font:16px/1.7 Georgia,serif;max-width:760px;margin:32px auto;padding:0 18px">' +
      "<h1>" + escapeHtml(report.title) + "</h1><p><i>" + escapeHtml(report.type) + " · " +
      escapeHtml(report.year) + " · " + escapeHtml(report.authors) + "</i></p><p><b>" +
      escapeHtml(report.summary) + "</b></p>" + bodyMarkup(report.body) + "<hr><p>PRIVC Atlas</p></body></html>";
    var url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    var link = document.createElement("a");
    link.href = url;
    link.download = report.title.replace(/[^\w.-]+/g, "-") + ".html";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function showReader(report, updateUrl) {
    var browser = document.getElementById("reports-browser");
    var reader = document.getElementById("reports-reader");
    if (!browser || !reader) return;
    browser.hidden = true;
    var pdf = pdfUrl(report);
    reader.innerHTML = '<div class="reports-reader-head"><button type="button" id="report-back">Back to reports</button>' +
      '<span class="report-type">' + escapeHtml(report.type) + "</span></div>" +
      '<article class="report-reading"><p class="report-reading-meta">' + escapeHtml(report.authors) +
      (report.authors ? " · " : "") + escapeHtml(report.year) + "</p>" +
      "<h2>" + escapeHtml(report.title) + "</h2>" +
      (report.summary ? '<p class="report-reading-summary">' + escapeHtml(report.summary) + "</p>" : "") +
      (pdf
        ? '<iframe class="report-pdf-viewer" title="PDF: ' + escapeHtml(report.title) + '" src="' +
          escapeHtml(pdf) + '"></iframe>'
        : '<div class="report-article-text">' + bodyMarkup(report.body) + "</div>") +
      "</article>";
    document.getElementById("report-back").addEventListener("click", backToList);
    if (updateUrl) history.pushState(null, "", location.pathname + location.search + "#report=" + encodeURIComponent(report.id));
    reader.focus();
    window.scrollTo(0, 0);
  }

  function backToList() {
    var browser = document.getElementById("reports-browser");
    var reader = document.getElementById("reports-reader");
    if (!browser || !reader) return;
    history.replaceState(null, "", location.pathname + location.search);
    reader.innerHTML = "";
    browser.hidden = false;
    document.getElementById("reports-search").focus();
  }

  function reportUrl(report) {
    return location.origin + location.pathname + location.search + "#report=" + encodeURIComponent(report.id);
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    var field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("aria-hidden", "true");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    var copied = document.execCommand("copy");
    field.remove();
    if (!copied) throw new Error("Clipboard access is unavailable. Copy the link from the address bar instead.");
  }

  function startEdit(report) {
    var dialog = document.getElementById("report-dialog");
    var form = document.getElementById("report-form");
    form.reset();
    document.getElementById("report-edit-id").value = report ? report.id : "";
    document.getElementById("report-dialog-title").textContent = report ? "Edit report" : "Write or publish";
    document.getElementById("report-title-input").value = report ? report.title : "";
    document.getElementById("report-authors-input").value = report ? report.authors : "";
    document.getElementById("report-year-input").value = report ? report.year : new Date().getFullYear();
    document.getElementById("report-type-input").value = report ? report.type : TYPES[0];
    document.getElementById("report-summary-input").value = report ? report.summary : "";
    document.getElementById("report-tags-input").value = report ? report.tags.join(", ") : "";
    document.getElementById("report-status-input").value = report ? report.status : "draft";
    document.getElementById("report-pdf-input").value = report ? report.pdf : "";
    document.getElementById("report-pdf-name-input").value = report ? report.pdfName : "";
    document.getElementById("report-body-input").value = report ? report.body : "";
    document.getElementById("report-form-error").textContent = "";
    form.querySelectorAll("[aria-invalid=true]").forEach(function (field) { field.removeAttribute("aria-invalid"); });
    dialog.showModal();
    document.getElementById("report-title-input").focus();
  }

  function normalizedPdf(value) {
    var pdf = value.trim();
    if (!pdf) return "";
    if (/^[a-z][a-z\d+.-]*:/i.test(pdf)) return pdf;
    if (pdf.indexOf("/") < 0 && pdf.indexOf("\\") < 0) return "reports/pdf/" + pdf;
    return pdf;
  }

  function validateForm() {
    var fields = [
      ["report-title-input", "Title is required."],
      ["report-authors-input", "Authors are required."],
      ["report-year-input", "Enter a valid year."],
      ["report-summary-input", "Summary is required."]
    ];
    var errors = [];
    fields.forEach(function (field) {
      var element = document.getElementById(field[0]);
      var valid = element.value.trim() !== "";
      if (field[0] === "report-year-input") {
        var year = Number(element.value);
        valid = Number.isInteger(year) && year >= 1800 && year <= new Date().getFullYear() + 1;
      }
      if (!valid) {
        element.setAttribute("aria-invalid", "true");
        errors.push(field[1]);
      } else {
        element.removeAttribute("aria-invalid");
      }
    });
    var body = document.getElementById("report-body-input").value.trim();
    var pdf = document.getElementById("report-pdf-input").value.trim();
    if (!body && !pdf) errors.push("Add article text or a PDF file name/link.");
    if (pdf && !pdfUrl({ pdf: normalizedPdf(pdf) })) errors.push("Use a valid HTTP(S) PDF link or a relative file path.");
    return errors;
  }

  async function submitReport(event) {
    event.preventDefault();
    var errorElement = document.getElementById("report-form-error");
    var errors = validateForm();
    if (errors.length) {
      errorElement.textContent = errors.join(" ");
      var firstInvalid = document.querySelector('#report-form [aria-invalid="true"]');
      if (firstInvalid) firstInvalid.focus();
      return;
    }
    var id = document.getElementById("report-edit-id").value || (
      window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() :
        "report-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9)
    );
    var report = {
      id: id,
      title: document.getElementById("report-title-input").value.trim(),
      authors: document.getElementById("report-authors-input").value.trim(),
      year: Number(document.getElementById("report-year-input").value),
      type: document.getElementById("report-type-input").value,
      summary: document.getElementById("report-summary-input").value.trim(),
      tags: document.getElementById("report-tags-input").value.split(",").map(function (tag) {
        return tag.trim();
      }).filter(Boolean),
      status: document.getElementById("report-status-input").value,
      pdf: normalizedPdf(document.getElementById("report-pdf-input").value),
      pdfName: document.getElementById("report-pdf-name-input").value.trim(),
      body: document.getElementById("report-body-input").value.trim()
    };
    try {
      await saveReport(report);
      document.getElementById("report-dialog").close();
      state.errors = state.errors.filter(function (message) {
        return message.indexOf("Browser-only reports could not be read:") !== 0;
      });
      renderFilters();
      renderList();
      setOperationStatus("Saved in this browser only. Export reports.json and publish it with the site to make it public.");
    } catch (error) {
      errorElement.textContent = "Could not save this report: " + error.message;
    }
  }

  function exportReports() {
    var byId = new Map();
    state.publicItems.forEach(function (item) { byId.set(item.id, item); });
    state.localItems.forEach(function (item) { byId.set(item.id, item); });
    var blob = new Blob([JSON.stringify(Array.from(byId.values()), null, 2)], { type: "application/json" });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "reports.json";
    var objectUrl = link.href;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 1000);
    setOperationStatus("Exported all public reports and browser-only items.");
  }

  function importReports(file) {
    var reader = new FileReader();
    reader.onerror = function () { setStatus("Could not read the selected JSON file.", true); };
    reader.onload = async function () {
      try {
        var imported = parseReportFile(JSON.parse(reader.result));
        var existing = new Set(mergedReports().map(function (item) { return item.id; }));
        var additions = imported.filter(function (item) {
          if (existing.has(item.id)) return false;
          existing.add(item.id);
          return true;
        });
        for (var i = 0; i < additions.length; i += 1) {
          await saveReport(additions[i]);
        }
        renderFilters();
        renderList();
        setOperationStatus("Imported " + additions.length + " new report(s); duplicate ids were skipped.");
      } catch (error) {
        setStatus("Import failed: " + error.message, true);
      }
    };
    reader.readAsText(file);
  }

  function renderShell(root) {
    root.innerHTML = '<div class="reports-head"><div><h2>Reports and articles</h2>' +
      '<p class="reports-intro">Explore published research, policy briefs and development reports.</p></div>' +
      '<button type="button" class="reports-primary" id="reports-write">Write or publish</button></div>' +
      '<p class="reports-publish-hint">To publish publicly, export reports.json, remove drafts you do not want exposed, place it in reports/ with PDFs in reports/pdf/, then deploy those files with index.html.</p>' +
      '<p class="reports-status" id="reports-status" role="status" aria-live="polite"></p>' +
      '<section id="reports-browser" aria-label="Browse reports"><div class="reports-filters">' +
      '<label>Search<input id="reports-search" type="search" placeholder="Title, author, year or tag" aria-label="Search by title, author, year or tag"></label>' +
      '<label>Type<select id="reports-type" aria-label="Filter by report type"><option value="">All types</option>' +
      TYPES.map(function (type) { return '<option value="' + escapeHtml(type) + '">' + escapeHtml(type) + "</option>"; }).join("") +
      '</select></label><label>Year<select id="reports-year" aria-label="Filter by year"><option value="">All years</option></select></label>' +
      '<label>Tag<select id="reports-tag" aria-label="Filter by tag"><option value="">All tags</option></select></label>' +
      '<label>Sort<select id="reports-sort" aria-label="Sort reports"><option value="newest">Newest</option>' +
      '<option value="oldest">Oldest</option><option value="title">Title</option></select></label></div>' +
      '<div id="reports-results" class="reports-grid" aria-live="polite"></div></section>' +
      '<section id="reports-reader" class="reports-reader" aria-label="Report reader" tabindex="-1"></section>' +
      '<div class="reports-import-export"><button type="button" id="reports-export">Export reports.json</button>' +
      '<button type="button" id="reports-import-button">Import reports.json</button>' +
      '<input type="file" id="reports-import-file" accept=".json,application/json" hidden aria-label="Choose reports JSON file"></div>' +
      '<dialog id="report-dialog" class="report-dialog" aria-labelledby="report-dialog-title"><form id="report-form" novalidate>' +
      '<div class="reports-dialog-heading"><h2 id="report-dialog-title">Write or publish</h2>' +
      '<button type="button" id="report-dialog-close" aria-label="Close publish form">Close</button></div>' +
      '<input id="report-edit-id" type="hidden"><label class="reports-field">Title <span aria-hidden="true">*</span>' +
      '<input id="report-title-input" required autocomplete="off"></label>' +
      '<label class="reports-field">Authors <span aria-hidden="true">*</span><input id="report-authors-input" required></label>' +
      '<div class="reports-form-row"><label class="reports-field">Year <span aria-hidden="true">*</span>' +
      '<input id="report-year-input" type="number" min="1800" required></label>' +
      '<label class="reports-field">Type <span aria-hidden="true">*</span><select id="report-type-input">' +
      TYPES.map(function (type) { return '<option>' + escapeHtml(type) + "</option>"; }).join("") + "</select></label>" +
      '<label class="reports-field">Status<select id="report-status-input"><option value="draft">Draft</option>' +
      '<option value="published">Published</option></select></label></div>' +
      '<label class="reports-field">Summary <span aria-hidden="true">*</span><textarea id="report-summary-input" rows="3" required></textarea></label>' +
      '<label class="reports-field">Tags <small>Comma-separated</small><input id="report-tags-input" placeholder="health, policy"></label>' +
      '<fieldset class="reports-content-field"><legend>PDF or article text</legend>' +
      '<label class="reports-field">PDF file name or link <small>Place local PDFs in reports/pdf/</small>' +
      '<input id="report-pdf-input" placeholder="reports/pdf/report.pdf or https://…"></label>' +
      '<label class="reports-field">PDF display name <input id="report-pdf-name-input" placeholder="Optional"></label>' +
      '<label class="reports-field">Article text <small>Use blank lines between paragraphs</small>' +
      '<textarea id="report-body-input" rows="7"></textarea></label></fieldset>' +
      '<p id="report-form-error" class="reports-form-error" role="alert" aria-live="assertive"></p>' +
      '<div class="reports-dialog-actions"><button type="button" id="report-dialog-cancel">Cancel</button>' +
      '<button type="submit" class="reports-primary">Save report</button></div></form></dialog>';

    document.getElementById("reports-type").value = "";
    document.getElementById("reports-write").addEventListener("click", function () { startEdit(null); });
    document.getElementById("report-form").addEventListener("submit", submitReport);
    var dialog = document.getElementById("report-dialog");
    dialog.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.preventDefault();
        dialog.close();
      }
    });
    dialog.addEventListener("cancel", function (event) {
      event.preventDefault();
      dialog.close();
    });
    document.getElementById("report-dialog-close").addEventListener("click", function () {
      document.getElementById("report-dialog").close();
    });
    document.getElementById("report-dialog-cancel").addEventListener("click", function () {
      document.getElementById("report-dialog").close();
    });
    document.getElementById("reports-export").addEventListener("click", exportReports);
    document.getElementById("reports-import-button").addEventListener("click", function () {
      document.getElementById("reports-import-file").click();
    });
    document.getElementById("reports-import-file").addEventListener("change", function () {
      if (this.files && this.files[0]) importReports(this.files[0]);
      this.value = "";
    });
    ["reports-search", "reports-type", "reports-year", "reports-tag", "reports-sort"].forEach(function (id) {
      var control = document.getElementById(id);
      control.addEventListener(id === "reports-search" ? "input" : "change", renderList);
    });
    document.getElementById("reports-results").addEventListener("click", async function (event) {
      var button = event.target.closest("button[data-action]");
      if (!button) return;
      var report = mergedReports().find(function (item) { return item.id === button.dataset.id; });
      if (!report) return;
      try {
        if (button.dataset.action === "read") showReader(report, true);
        if (button.dataset.action === "article") downloadArticle(report);
        if (button.dataset.action === "copy") {
          await copyText(reportUrl(report));
          setStatus("Shareable report link copied.");
        }
        if (button.dataset.action === "download") {
          var pdf = pdfUrl(report);
          if (!pdf) return;
          var link = document.createElement("a");
          link.href = pdf;
          link.download = report.pdfName || report.title.replace(/[^\w.-]+/g, "-") + ".pdf";
          link.target = "_blank";
          link.rel = "noopener";
          document.body.appendChild(link);
          link.click();
          link.remove();
        }
        if (button.dataset.action === "edit" && report.source === "local") startEdit(report);
        if (button.dataset.action === "delete" && report.source === "local" &&
            window.confirm('Delete "' + report.title + '" from this browser?')) {
          await deleteReport(report.id);
          renderFilters();
          renderList();
          setOperationStatus("Browser-only report deleted.");
        }
      } catch (error) {
        setStatus("Action failed: " + error.message, true);
      }
    });
  }

  async function initReports() {
    var root = document.getElementById("rpv");
    if (!root) return;
    renderShell(root);
    setStatus("Loading reports…");
    document.getElementById("reports-results").innerHTML = '<div class="reports-loading" role="status">Loading reports…</div>';
    var pending = ensureReportsLoaded();
    pending.then(function (result) {
      renderFilters();
      renderList();
      if (state.errors.length) setStatus(state.errors.join(" "));
      else setStatus(state.localItems.length + " browser-only report(s) are saved on this device.");
      var id = currentHashId();
      if (id) {
        var report = mergedReports().find(function (item) { return item.id === id; });
        if (report) showReader(report, false);
        else setStatus("This report link could not be found in the public reports or this browser.", true);
      }
    });
    await pending;
  }

  function openHashReport() {
    var id = currentHashId();
    var root = document.getElementById("rpv");
    if (!id) {
      var reader = document.getElementById("reports-reader");
      var browser = document.getElementById("reports-browser");
      if (reader && browser && browser.hidden) {
        reader.innerHTML = "";
        browser.hidden = false;
      }
      return;
    }
    if (!root || root.classList.contains("hide")) {
      if (typeof window.tab === "function") window.tab("rpv");
      else {
        var menuButton = document.querySelector('.mt[data-t="rpv"]');
        if (menuButton) menuButton.click();
      }
    }
    loadPromise.then(function () {
      var report = mergedReports().find(function (item) { return item.id === id; });
      if (report) showReader(report, false);
    });
  }

  window.initReports = initReports;
  window.addEventListener("hashchange", openHashReport);
  window.addEventListener("popstate", openHashReport);
  window.addEventListener("DOMContentLoaded", function () {
    ensureReportsLoaded();
    openHashReport();
  });
})();
