(function () {
  "use strict";

  var BUCKET = "privc-papers";
  var MAX_PDF_BYTES = 25 * 1024 * 1024;
  var PUBLIC_FIELDS = "id,title,abstract,keywords,status,created_at,published_at";
  var PRIVATE_FIELDS = "id,author_id,title,abstract,keywords,status,pdf_path,review_feedback,submitted_at,reviewed_at,reviewed_by,published_at,created_at,updated_at";
  var session = null;
  var papers = [];
  var loadVersion = 0;
  var busy = false;
  var editingPaper = null;
  var dialog;
  var status;

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function client() {
    if (!window.PRIVC_AUTH || !window.PRIVC_AUTH.client) {
      throw new Error(window.PRIVC_AUTH && window.PRIVC_AUTH.initError ||
        "Supabase is not ready. Check config.js and the network.");
    }
    return window.PRIVC_AUTH.client;
  }

  function setStatus(message, isError) {
    status.textContent = message || "";
    status.classList.toggle("error", Boolean(isError));
  }

  function setBusy(value) {
    busy = value;
    dialog.querySelectorAll("button, input, textarea").forEach(function (element) {
      element.disabled = value;
    });
    dialog.querySelector("#paper-close").disabled = false;
  }

  function paperCard(paper, isPublic) {
    var html = '<article class="paper-card"><div class="paper-card-head"><h3>' +
      escapeHtml(paper.title) + '</h3><span class="paper-status">' + escapeHtml(paper.status) +
      "</span></div>" +
      (paper.abstract ? '<p class="paper-abstract">' + escapeHtml(paper.abstract) + "</p>" : "") +
      (paper.keywords && paper.keywords.length
        ? '<p class="paper-keywords">' + escapeHtml(paper.keywords.join(", ")) + "</p>" : "");
    if (isPublic) {
      html += '<button type="button" class="paper-download" data-download="' +
        escapeHtml(paper.id) + '">Download PDF</button>';
    } else {
      html += '<p class="paper-card-meta">Updated ' +
        escapeHtml(new Date(paper.updated_at || paper.created_at).toLocaleDateString()) +
        "</p>";
      if (paper.review_feedback) {
        html += '<p class="paper-feedback"><b>Reviewer feedback</b><br>' +
          escapeHtml(paper.review_feedback) + "</p>";
      }
      if (paper.pdf_path) {
        html += '<button type="button" data-download="' + escapeHtml(paper.id) +
          '">Download my PDF</button> ';
      }
      if (paper.status === "Draft" || paper.status === "Revisions requested") {
        html += '<button type="button" data-edit="' + escapeHtml(paper.id) + '">' +
          (paper.status === "Draft" ? "Edit draft" : "Revise and resubmit") + "</button>";
      }
    }
    return html + "</article>";
  }

  function reviewCard(paper) {
    var actions = "";
    if (paper.status === "Submitted") {
      actions = '<button type="button" data-review-status="In review">Start review</button>';
    } else if (paper.status === "In review") {
      actions = '<button type="button" data-review-status="Revisions requested">Request revisions</button>' +
        '<button type="button" data-review-status="Published" class="pri">Publish</button>' +
        '<button type="button" data-review-status="Rejected">Reject</button>';
    }
    return '<article class="paper-card paper-review-card" data-review-paper="' + escapeHtml(paper.id) +
      '"><div class="paper-card-head"><h3>' + escapeHtml(paper.title) +
      '</h3><span class="paper-status">' + escapeHtml(paper.status) + "</span></div>" +
      '<p class="paper-card-meta">Author ID: ' + escapeHtml(paper.author_id) +
      " · Submitted " + escapeHtml(paper.submitted_at
        ? new Date(paper.submitted_at).toLocaleDateString() : "—") + "</p>" +
      (paper.abstract ? '<p class="paper-abstract">' + escapeHtml(paper.abstract) + "</p>" : "") +
      (paper.keywords && paper.keywords.length
        ? '<p class="paper-keywords">' + escapeHtml(paper.keywords.join(", ")) + "</p>" : "") +
      (paper.pdf_path ? '<button type="button" data-download="' + escapeHtml(paper.id) +
        '">Review PDF</button>' : '<p class="paper-feedback">PDF not uploaded.</p>') +
      '<label class="paper-field">Feedback<textarea data-review-feedback rows="3" maxlength="12000">' +
      escapeHtml(paper.review_feedback || "") + "</textarea></label>" +
      '<div class="paper-review-actions">' + actions + "</div></article>";
  }

  function renderPapers(publicRows, ownRows, reviewRows) {
    var publicList = dialog.querySelector("#published-papers");
    publicList.innerHTML = publicRows.length
      ? publicRows.map(function (paper) { return paperCard(paper, true); }).join("")
      : '<p class="paper-muted">No papers have been published yet.</p>';

    var myList = dialog.querySelector("#my-papers");
    myList.innerHTML = !session
      ? '<p class="paper-muted">Sign in to submit a paper or view your submissions.</p>'
      : ownRows.length
        ? ownRows.map(function (paper) { return paperCard(paper, false); }).join("")
        : '<p class="paper-muted">You have no submissions yet.</p>';

    var reviewSection = dialog.querySelector("#paper-review-section");
    reviewSection.hidden = !reviewRows;
    if (reviewRows) {
      var reviewList = dialog.querySelector("#paper-review-queue");
      reviewList.innerHTML = reviewRows.length
        ? reviewRows.map(reviewCard).join("")
        : '<p class="paper-muted">The review queue is empty.</p>';
    }
  }

  async function loadPapers() {
    var version = ++loadVersion;
    var userId = session && session.user.id;
    setStatus("Loading papers…");
    try {
      var publicResult = await client().from("papers").select(PUBLIC_FIELDS)
        .eq("status", "Published").order("published_at", { ascending: false });
      if (publicResult.error) throw publicResult.error;

      var ownRows = [];
      var reviewRows = null;
      if (session) {
        var ownResult = await client().from("papers").select(PRIVATE_FIELDS)
          .eq("author_id", userId).order("updated_at", { ascending: false });
        if (ownResult.error) throw ownResult.error;
        ownRows = ownResult.data || [];

        var reviewerResult = await client().rpc("privc_get_review_queue");
        if (reviewerResult.error) {
          if (reviewerResult.error.code !== "42501") throw reviewerResult.error;
        } else {
          var queueResult = reviewerResult;
          reviewRows = queueResult.data || [];
        }
      }
      if (version !== loadVersion || userId !== (session && session.user.id)) return;
      papers = ownRows.concat(reviewRows || []);
      renderPapers(publicResult.data || [], ownRows, reviewRows);
      setStatus("");
    } catch (error) {
      if (version !== loadVersion) return;
      setStatus("Could not load papers: " + (error.message || "Supabase request failed."), true);
    }
  }

  function resetForm() {
    editingPaper = null;
    dialog.querySelector("#paper-form").reset();
    dialog.querySelector("#paper-save-draft").textContent = "Save draft";
    dialog.querySelector("#paper-submit").textContent = "Submit paper";
    dialog.querySelector("#paper-form-title").textContent = "Submit a paper";
    dialog.querySelector("#paper-cancel-edit").hidden = true;
  }

  function editPaper(id) {
    var paper = papers.find(function (item) { return item.id === id; });
    if (!paper) return;
    editingPaper = paper;
    dialog.querySelector("#paper-title").value = paper.title || "";
    dialog.querySelector("#paper-abstract").value = paper.abstract || "";
    dialog.querySelector("#paper-keywords").value = (paper.keywords || []).join(", ");
    dialog.querySelector("#paper-form-title").textContent =
      paper.status === "Draft" ? "Edit draft" : "Revise and resubmit";
    dialog.querySelector("#paper-save-draft").textContent = "Save changes";
    dialog.querySelector("#paper-submit").textContent = "Save and resubmit";
    dialog.querySelector("#paper-title").focus();
  }

  function keywordsFromInput(value) {
    return value.split(",").map(function (item) { return item.trim(); })
      .filter(Boolean).slice(0, 20);
  }

  async function uploadPdf(file, path) {
    if (!file) return;
    if (file.size <= 0 || file.size > MAX_PDF_BYTES) {
      throw new Error("Choose a PDF smaller than 25 MB.");
    }
    if (file.type && file.type !== "application/pdf") {
      throw new Error("The selected file must be a PDF.");
    }
    if ((await file.slice(0, 5).text()) !== "%PDF-") {
      throw new Error("The selected file does not appear to be a valid PDF.");
    }
    var upload = await client().storage.from(BUCKET).upload(path, file, {
      contentType: "application/pdf",
      upsert: true
    });
    if (upload.error) throw upload.error;
  }

  async function savePaper(event) {
    event.preventDefault();
    if (!session || busy) return;
    var title = dialog.querySelector("#paper-title").value.trim();
    var abstract = dialog.querySelector("#paper-abstract").value.trim();
    var keywords = keywordsFromInput(dialog.querySelector("#paper-keywords").value);
    var file = dialog.querySelector("#paper-pdf").files[0] || null;
    var submit = event.submitter && event.submitter.dataset.paperAction === "submit";
    if (!title || title.length > 240) {
      setStatus("Enter a title no longer than 240 characters.", true);
      return;
    }
    if (abstract.length > 12000) {
      setStatus("The abstract must be 12,000 characters or fewer.", true);
      return;
    }
    try {
      setBusy(true);
      setStatus(editingPaper ? "Saving your changes…" : "Creating your draft…");
      var paper = editingPaper;
      if (paper) {
        var update = await client().from("papers").update({
          title: title, abstract: abstract, keywords: keywords
        }).eq("id", paper.id).select(PRIVATE_FIELDS).single();
        if (update.error) throw update.error;
        paper = update.data;
      } else {
        var insert = await client().from("papers").insert({
          author_id: session.user.id, title: title, abstract: abstract, keywords: keywords
        }).select(PRIVATE_FIELDS).single();
        if (insert.error) throw insert.error;
        paper = insert.data;
      }

      if (file) {
        var path = session.user.id + "/" + paper.id + ".pdf";
        await uploadPdf(file, path);
        var pathUpdate = await client().from("papers").update({ pdf_path: path })
          .eq("id", paper.id).select(PRIVATE_FIELDS).single();
        if (pathUpdate.error) throw pathUpdate.error;
        paper = pathUpdate.data;
      }
      if (submit) {
        var submitted = await client().rpc("privc_submit_paper", { p_paper_id: paper.id });
        if (submitted.error) throw submitted.error;
        setStatus("Paper submitted for review.");
      } else {
        setStatus("Draft saved.");
      }
      resetForm();
      await loadPapers();
    } catch (error) {
      await loadPapers();
      setStatus("Could not save the paper: " + (error.message || "Request failed."), true);
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf(id) {
    var tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      var result = await client().functions.invoke("paper-pdf", {
        body: { paper_id: id }
      });
      if (result.error) throw result.error;
      if (!result.data || !result.data.url) throw new Error("The PDF link was not returned.");
      if (tab) tab.location = result.data.url;
      else window.location.assign(result.data.url);
    } catch (error) {
      if (tab) tab.close();
      setStatus("Could not open the PDF: " + (error.message || "Request failed."), true);
    }
  }

  async function reviewPaper(event) {
    var button = event.target.closest("[data-review-status]");
    if (!button || busy) return;
    var card = button.closest("[data-review-paper]");
    if (!card) return;
    var paperId = card.dataset.reviewPaper;
    var feedback = card.querySelector("[data-review-feedback]").value.trim();
    try {
      setBusy(true);
      var result = await client().rpc("privc_review_paper", {
        p_paper_id: paperId,
        p_status: button.dataset.reviewStatus,
        p_feedback: feedback || null
      });
      if (result.error) throw result.error;
      setStatus("Review decision saved.");
      await loadPapers();
    } catch (error) {
      setStatus("Could not save the review decision: " + (error.message || "Request failed."), true);
    } finally {
      setBusy(false);
    }
  }

  function createInterface() {
    var topBar = document.querySelector(".top");
    var wrap = document.querySelector(".wrap");
    if (!topBar || !wrap) throw new Error("The PRIVC Atlas page shell could not be found.");

    var openButton = document.createElement("button");
    openButton.type = "button";
    openButton.id = "papers-open";
    openButton.textContent = "Papers";
    openButton.setAttribute("aria-haspopup", "dialog");
    topBar.appendChild(openButton);

    var root = document.createElement("div");
    root.innerHTML = '<dialog id="papers-dialog" class="papers-dialog" aria-labelledby="papers-title">' +
      '<div class="papers-dialog-inner"><div class="papers-head"><h2 id="papers-title">Papers</h2>' +
      '<button type="button" id="paper-close" aria-label="Close papers">Close</button></div>' +
      '<p class="paper-muted">Only published papers are shown publicly. Submitted PDFs remain in private storage.</p>' +
      '<section><h3>Published papers</h3><div id="published-papers" class="paper-list"></div></section>' +
      '<section id="paper-account-section" hidden><h3>My submissions</h3>' +
      '<div id="my-papers" class="paper-list"></div></section>' +
      '<section id="paper-upload-section" hidden><h3 id="paper-form-title">Submit a paper</h3>' +
      '<form id="paper-form" novalidate><label class="paper-field">Title' +
      '<input id="paper-title" maxlength="240" required></label>' +
      '<label class="paper-field">Abstract<textarea id="paper-abstract" rows="5" maxlength="12000"></textarea></label>' +
      '<label class="paper-field">Keywords, separated by commas' +
      '<input id="paper-keywords" maxlength="1000"></label>' +
      '<label class="paper-field">PDF (maximum 25 MB)' +
      '<input id="paper-pdf" type="file" accept="application/pdf,.pdf"></label>' +
      '<div class="paper-form-actions"><button type="submit" id="paper-save-draft" data-paper-action="draft">Save draft</button>' +
      '<button type="submit" id="paper-submit" class="pri" data-paper-action="submit">Submit paper</button>' +
      '<button type="button" id="paper-cancel-edit" hidden>Cancel edit</button></div></form></section>' +
      '<section id="paper-review-section" hidden><h3>Admin review queue</h3>' +
      '<p class="paper-muted">Staff actions and feedback are recorded with each paper.</p>' +
      '<div id="paper-review-queue" class="paper-list"></div></section>' +
      '<p id="paper-status" class="paper-status-message" role="status" aria-live="polite"></p></div></dialog>';
    document.body.appendChild(root);
    dialog = document.getElementById("papers-dialog");
    status = document.getElementById("paper-status");

    openButton.addEventListener("click", function () {
      dialog.showModal();
      loadPapers();
    });
    document.getElementById("paper-close").addEventListener("click", function () {
      dialog.close();
    });
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close();
    });
    dialog.querySelector("#paper-form").addEventListener("submit", savePaper);
    dialog.querySelector("#paper-pdf").addEventListener("change", function () {
      dialog.querySelector("#paper-pdf").required = false;
    });
    dialog.querySelector("#paper-save-draft").addEventListener("click", function () {
      dialog.querySelector("#paper-pdf").required = false;
    });
    dialog.querySelector("#paper-submit").addEventListener("click", function () {
      if (!editingPaper || !editingPaper.pdf_path) {
        dialog.querySelector("#paper-pdf").required = true;
      }
    });
    dialog.querySelector("#paper-cancel-edit").addEventListener("click", function () {
      resetForm();
      dialog.querySelector("#paper-cancel-edit").hidden = true;
    });
    dialog.addEventListener("click", function (event) {
      var editButton = event.target.closest("[data-edit]");
      if (editButton) {
        editPaper(editButton.dataset.edit);
        dialog.querySelector("#paper-cancel-edit").hidden = false;
        return;
      }
      var downloadButton = event.target.closest("[data-download]");
      if (downloadButton) {
        downloadPdf(downloadButton.dataset.download);
        return;
      }
      reviewPaper(event);
    });

    window.addEventListener("privc:authchange", function (event) {
      session = event.detail && event.detail.session || null;
      loadVersion++;
      var accountSection = dialog.querySelector("#paper-account-section");
      var uploadSection = dialog.querySelector("#paper-upload-section");
      accountSection.hidden = !session;
      uploadSection.hidden = !session;
      if (dialog.open) loadPapers();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    try {
      createInterface();
    } catch (error) {
      console.error("Paper workflow could not initialize:", error);
    }
  });
})();
