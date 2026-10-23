(function () {
  "use strict";

  var BUCKET = "privc-papers";
  var MAX_PDF_BYTES = 25 * 1024 * 1024;
  var PUBLIC_FIELDS = "id,author_id,title,abstract,keywords,status,publication_year,view_count,created_at,published_at";
  var PRIVATE_FIELDS = "id,author_id,title,abstract,keywords,status,publication_year,view_count,pdf_path,review_feedback,submitted_at,reviewed_at,reviewed_by,published_at,created_at,updated_at";
  var session = null;
  var papers = [];
  var loadVersion = 0;
  var feedRows = [];
  var feedAuthors = {};
  var feedOffset = 0;
  var feedHasMore = true;
  var feedLoading = false;
  var routeVersion = 0;
  var busy = false;
  var editingPaper = null;
  var topBar;
  var wrap;
  var dialog;
  var status;
  var feedView;
  var paperView;
  var detailStatus;

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

  function routeBase() {
    return window.PRIVC_AUTH ? window.PRIVC_AUTH.siteBasePath() : "/";
  }

  async function requireActiveSession() {
    try {
      var sessionResult = await client().auth.getSession();
      if (sessionResult.error || !sessionResult.data || !sessionResult.data.session) {
        var accountButton = document.getElementById("account-open");
        if (accountButton && typeof accountButton.click === "function") accountButton.click();
        return null;
      }
      return sessionResult.data.session;
    } catch (error) {
      var accountButton = document.getElementById("account-open");
      if (accountButton && typeof accountButton.click === "function") accountButton.click();
      return null;
    }
  }

  async function loadPaperEngagement(paperId) {
    var userSession = null;
    try {
      var sessionResult = await client().auth.getSession();
      if (!sessionResult.error && sessionResult.data && sessionResult.data.session) userSession = sessionResult.data.session;
    } catch (error) {
      userSession = null;
    }

    async function loadCount(functionName, tableName) {
      var result;
      try {
        result = await client().rpc(functionName, { p_paper_id: paperId });
      } catch (error) {
        result = { error: error };
      }
      if (!result || result.error) {
        var fallback = await client().from(tableName).select("paper_id", {
          count: "exact",
          head: true
        }).eq("paper_id", paperId);
        if (fallback.error) throw fallback.error;
        return Number(fallback.count || 0);
      }
      return Number(result.data || 0);
    }

    var counts = await Promise.all([
      loadCount("privc_paper_like_count", "paper_likes"),
      loadCount("privc_paper_comment_count", "paper_comments")
    ]);
    var bookmarkResult = userSession
      ? await client().from("paper_bookmarks").select("paper_id").eq("paper_id", paperId).eq("user_id", userSession.user.id).maybeSingle()
      : { data: null, error: null };
    var likeStateResult = userSession
      ? await client().from("paper_likes").select("paper_id").eq("paper_id", paperId).eq("user_id", userSession.user.id).maybeSingle()
      : { data: null, error: null };
    return {
      like_count: counts[0],
      comment_count: counts[1],
      liked: !likeStateResult.error && Boolean(likeStateResult.data),
      bookmarked: !bookmarkResult.error && Boolean(bookmarkResult.data)
    };
  }

  function paperEngagementMarkup(paper, state) {
    var likeCount = Number(state && state.like_count || 0).toLocaleString();
    var commentCount = Number(state && state.comment_count || 0).toLocaleString();
    var likedClass = state && state.liked ? " on" : "";
    var bookmarkedClass = state && state.bookmarked ? " on" : "";
    var paperId = escapeHtml(paper.id);
    return '<div class="paper-engagement" data-paper-engagement="' + paperId + '">' +
      '<button type="button" class="paper-action paper-like-btn' + likedClass + '" data-paper-like="' + paperId + '">' +
      (state && state.liked ? '♥' : '♡') + ' <span class="paper-like-count">' + likeCount + '</span></button>' +
      '<button type="button" class="paper-action paper-comment-btn" data-paper-comment-toggle="' + paperId + '">💬 <span class="paper-comment-count">' + commentCount + '</span></button>' +
      '<button type="button" class="paper-action paper-bookmark-btn' + bookmarkedClass + '" data-paper-bookmark="' + paperId + '">' +
      (state && state.bookmarked ? '🔖' : '📑') + '</button>' +
      '<div class="paper-comment-box" data-paper-comment-box="' + paperId + '" hidden></div>' +
      '</div>';
  }

  async function renderPaperEngagement(paperId, rootElement) {
    if (!rootElement) return;
    var state = await loadPaperEngagement(paperId);
    var likeButtons = rootElement.querySelectorAll("[data-paper-like]");
    var commentButtons = rootElement.querySelectorAll("[data-paper-comment-toggle]");
    var bookmarkButtons = rootElement.querySelectorAll("[data-paper-bookmark]");
    var commentBox = rootElement.querySelector("[data-paper-comment-box]");
    likeButtons.forEach(function (button) {
      if (button.dataset.paperLike !== paperId) return;
      button.classList.toggle("on", state.liked);
      button.innerHTML = (state.liked ? '♥' : '♡') + ' <span class="paper-like-count">' + Number(state.like_count || 0).toLocaleString() + '</span>';
      button.addEventListener("click", async function () {
        var session = await requireActiveSession();
        if (!session) return;
        try {
          if (state.liked) {
            await client().from("paper_likes").delete().eq("paper_id", paperId).eq("user_id", session.user.id);
            state.liked = false;
            state.like_count = Math.max(0, state.like_count - 1);
          } else {
            await client().from("paper_likes").insert({ paper_id: paperId, user_id: session.user.id });
            state.liked = true;
            state.like_count += 1;
          }
          button.innerHTML = (state.liked ? '♥' : '♡') + ' <span class="paper-like-count">' + Number(state.like_count || 0).toLocaleString() + '</span>';
          button.classList.toggle("on", state.liked);
        } catch (error) {
          button.textContent = error.message || "Could not update like.";
        }
      });
    });
    bookmarkButtons.forEach(function (button) {
      if (button.dataset.paperBookmark !== paperId) return;
      button.classList.toggle("on", state.bookmarked);
      button.textContent = state.bookmarked ? "🔖" : "📑";
      button.addEventListener("click", async function () {
        var session = await requireActiveSession();
        if (!session) return;
        try {
          if (state.bookmarked) {
            await client().from("paper_bookmarks").delete().eq("paper_id", paperId).eq("user_id", session.user.id);
            state.bookmarked = false;
          } else {
            await client().from("paper_bookmarks").insert({ paper_id: paperId, user_id: session.user.id });
            state.bookmarked = true;
          }
          button.classList.toggle("on", state.bookmarked);
          button.textContent = state.bookmarked ? "🔖" : "📑";
        } catch (error) {
          button.textContent = error.message || "Could not update bookmark.";
        }
      });
    });
    commentButtons.forEach(function (button) {
      if (button.dataset.paperCommentToggle !== paperId) return;
      button.addEventListener("click", async function () {
        var session = await requireActiveSession();
        if (!session) return;
        if (!commentBox) return;
        var hidden = commentBox.hidden;
        commentBox.hidden = !hidden;
        if (hidden) {
          await loadCommentThread(paperId, commentBox);
        }
      });
    });
  }

  async function loadCommentThread(paperId, commentBox) {
    if (!commentBox) return;
    try {
      var result = await client().from("paper_comments")
        .select("id,paper_id,user_id,parent_comment_id,body,created_at")
        .eq("paper_id", paperId)
        .order("created_at", { ascending: true });
      if (result.error) throw result.error;
      var rows = result.data || [];
      var byParent = {};
      rows.forEach(function (comment) {
        var key = comment.parent_comment_id || "root";
        if (!byParent[key]) byParent[key] = [];
        byParent[key].push(comment);
      });
      function renderComments(parentKey, depth) {
        var list = byParent[parentKey] || [];
        return list.map(function (comment) {
          var children = renderComments(comment.id, depth + 1);
          return '<div class="paper-comment" style="margin-left:' + (depth * 12) + 'px; margin-top:8px; border-left:1px solid rgba(132,140,208,.25); padding-left:8px;">' +
            '<div class="paper-card-meta">' + escapeHtml(comment.user_id.slice(0, 8)) + ' · ' + escapeHtml(new Date(comment.created_at).toLocaleDateString()) + '</div>' +
            '<div>' + escapeHtml(comment.body) + '</div>' +
            '<button type="button" class="paper-action paper-reply-btn" data-paper-reply="' + escapeHtml(comment.id) + '">Reply</button>' +
            '<button type="button" class="paper-action" data-report-comment="' + escapeHtml(comment.id) +
            '"' + (session ? "" : " hidden") + '>Report</button>' +
            children +
            '</div>';
        }).join("");
      }
      var form = '<form class="paper-comment-form" data-paper-comment-form="' + escapeHtml(paperId) + '">' +
        '<textarea rows="2" data-paper-comment-body placeholder="Add a comment…" maxlength="2000"></textarea>' +
        '<div class="row"><button type="submit" class="pri">Comment</button></div>' +
        '</form>';
      commentBox.innerHTML = '<div class="paper-comment-list">' + renderComments("root", 0) + '</div>' + form;
      commentBox.querySelector(".paper-comment-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        var session = await requireActiveSession();
        if (!session) return;
        var textarea = commentBox.querySelector("[data-paper-comment-body]");
        var body = String(textarea.value || "").trim();
        if (!body) return;
        try {
          await client().from("paper_comments").insert({
            paper_id: paperId,
            user_id: session.user.id,
            body: body
          });
          textarea.value = "";
          await loadCommentThread(paperId, commentBox);
          var count = await loadPaperEngagement(paperId);
          var commentCountButton = commentBox.closest(".paper-engagement") && commentBox.closest(".paper-engagement").querySelector(".paper-comment-count");
          if (commentCountButton) commentCountButton.textContent = Number(count.comment_count || 0).toLocaleString();
        } catch (error) {
          textarea.value = error.message || "Comment failed.";
        }
      });
      commentBox.querySelectorAll("[data-paper-reply]").forEach(function (replyButton) {
        replyButton.addEventListener("click", async function () {
          var session = await requireActiveSession();
          if (!session) return;
          var replyForm = '<form class="paper-comment-form" data-paper-reply-form="' + escapeHtml(replyButton.dataset.paperReply) + '">' +
            '<textarea rows="2" data-paper-reply-body placeholder="Write a reply…" maxlength="2000"></textarea>' +
            '<div class="row"><button type="submit" class="pri">Reply</button></div>' +
            '</form>';
          var replyHost = replyButton.parentElement;
          if (replyHost.querySelector("[data-paper-reply-form]")) return;
          replyHost.insertAdjacentHTML("beforeend", replyForm);
          var replyFormElement = replyHost.querySelector("[data-paper-reply-form]");
          replyFormElement.addEventListener("submit", async function (replyEvent) {
            replyEvent.preventDefault();
            var replyBody = String(replyFormElement.querySelector("[data-paper-reply-body]").value || "").trim();
            if (!replyBody) return;
            try {
              await client().from("paper_comments").insert({
                paper_id: paperId,
                user_id: session.user.id,
                parent_comment_id: replyButton.dataset.paperReply,
                body: replyBody
              });
              await loadCommentThread(paperId, commentBox);
            } catch (error) {
              replyFormElement.querySelector("[data-paper-reply-body]").value = error.message || "Reply failed.";
            }
          });
        });
      });
    } catch (error) {
      commentBox.innerHTML = '<div class="paper-muted error">Could not load comments: ' + escapeHtml(error.message || "Supabase request failed.") + '</div>';
    }
  }

  function paperPath(id) {
    return routeBase() + "papers/" + encodeURIComponent(id);
  }

  function authorHref(profile) {
    return routeBase() + "u/" + encodeURIComponent(profile.username);
  }

  function publicAuthorMarkup(paper) {
    var author = feedAuthors[paper.author_id];
    if (!author) return '<div class="paper-author"><span class="paper-author-avatar" aria-hidden="true">?</span>' +
      '<span>Researcher</span></div>';
    var name = escapeHtml(author.display_name || author.username);
    var avatar = "";
    try {
      var url = new URL(author.avatar_url || "", window.location.href);
      if ((url.protocol === "https:" || url.protocol === "http:") && author.avatar_url) {
        avatar = '<img src="' + escapeHtml(url.href) + '" alt="">';
      }
    } catch (error) {
      avatar = "";
    }
    var contents = '<span class="paper-author-avatar">' + (avatar || escapeHtml(
      String(author.display_name || author.username || "?").trim().slice(0, 1).toUpperCase())) +
      '</span><span>' + name + '</span>';
    return author.username
      ? '<a class="paper-author" href="' + escapeHtml(authorHref(author)) +
        '" data-profile-username="' + escapeHtml(author.username) + '">' + contents + '</a>'
      : '<div class="paper-author">' + contents + '</div>';
  }

  function publicPaperCard(paper, engagementState) {
    var state = engagementState || { like_count: 0, comment_count: 0, liked: false, bookmarked: false };
    return '<article class="paper-card paper-feed-card">' +
      '<div class="paper-feed-byline">' + publicAuthorMarkup(paper) +
      '<span class="paper-card-meta">' + escapeHtml(paper.publication_year || "Year not set") +
      ' · ' + escapeHtml(Number(paper.view_count || 0).toLocaleString()) + ' views</span></div>' +
      '<h3><a href="' + escapeHtml(paperPath(paper.id)) + '" data-paper-detail="' +
      escapeHtml(paper.id) + '">' + escapeHtml(paper.title) + '</a></h3>' +
      (paper.abstract ? '<p class="paper-abstract paper-feed-abstract">' +
        escapeHtml(paper.abstract) + '</p>' : "") +
      (paper.keywords && paper.keywords.length
        ? '<p class="paper-keywords"><b>Topics:</b> ' +
          escapeHtml(paper.keywords.join(", ")) + "</p>" : "") +
      paperEngagementMarkup(paper, state) +
      '<a class="paper-open-link" href="' + escapeHtml(paperPath(paper.id)) +
      '" data-paper-detail="' + escapeHtml(paper.id) + '">View paper</a></article>';
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
      html += paperEngagementMarkup(paper, { like_count: 0, comment_count: 0, liked: false, bookmarked: false });
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
      html += paperEngagementMarkup(paper, { like_count: 0, comment_count: 0, liked: false, bookmarked: false });
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

  function reportCard(report) {
    var target = report.target_type === "paper"
      ? '<p><b>Reported paper:</b> ' + escapeHtml(report.paper_title || "Paper title unavailable.") + "</p>"
      : '<p><b>Paper:</b> ' + escapeHtml(report.paper_title || "Paper title unavailable.") +
        '</p><p><b>Reported comment:</b> ' + escapeHtml(report.comment_body || "Comment text unavailable.") + "</p>";
    return '<article class="paper-card" data-paper-report="' + escapeHtml(report.id) + '">' +
      '<div class="paper-card-meta">' + escapeHtml(report.target_type === "paper" ? "Paper report" : "Comment report") +
      ' · ' + escapeHtml(new Date(report.created_at).toLocaleDateString()) + "</div>" +
      target +
      '<p><b>Reason:</b> ' + escapeHtml(report.reason) + "</p>" +
      '<p><b>Reporter note:</b> ' + escapeHtml(report.note || "No note provided.") + "</p>" +
      '<label class="paper-field">Resolution note (optional)' +
      '<textarea data-report-resolution-note rows="2" maxlength="500"></textarea></label>' +
      '<div class="paper-review-actions"><button type="button" data-report-status="resolved">Resolve</button>' +
      '<button type="button" data-report-status="dismissed">Dismiss</button></div></article>';
  }

  function renderPapers(publicRows, ownRows, reviewRows, reportState) {
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

    var reportSection = dialog.querySelector("#paper-report-section");
    var reportList = dialog.querySelector("#paper-report-list");
    reportSection.hidden = !reportState;
    if (reportState) {
      reportList.innerHTML = reportState.error
        ? '<p class="paper-muted error">Could not load reports: ' + escapeHtml(reportState.error) + "</p>"
        : reportState.rows.length
          ? reportState.rows.map(reportCard).join("")
          : '<p class="paper-muted">There are no open reports.</p>';
    }
  }

  async function loadOpenReports() {
    var result = await client().from("paper_reports")
      .select("id,target_type,paper_id,comment_id,reason,note,created_at")
      .eq("status", "open")
      .order("created_at", { ascending: true });
    if (result.error) throw result.error;
    var reports = result.data || [];
    if (!reports.length) return [];

    var commentIds = reports.filter(function (report) {
      return report.target_type === "comment" && report.comment_id;
    }).map(function (report) { return report.comment_id; });
    var comments = [];
    if (commentIds.length) {
      var commentResult = await client().from("paper_comments")
        .select("id,paper_id,body")
        .in("id", commentIds);
      if (commentResult.error) throw commentResult.error;
      comments = commentResult.data || [];
    }

    var paperIds = reports.filter(function (report) {
      return report.target_type === "paper" && report.paper_id;
    }).map(function (report) { return report.paper_id; });
    paperIds = paperIds.concat(comments.map(function (comment) { return comment.paper_id; }));
    paperIds = paperIds.filter(function (id, index) { return paperIds.indexOf(id) === index; });
    var paperTitles = {};
    if (paperIds.length) {
      var paperResult = await client().from("papers").select("id,title").in("id", paperIds);
      if (paperResult.error) throw paperResult.error;
      (paperResult.data || []).forEach(function (paper) {
        paperTitles[paper.id] = paper.title;
      });
    }
    var commentsById = {};
    comments.forEach(function (comment) { commentsById[comment.id] = comment; });
    return reports.map(function (report) {
      var comment = report.comment_id && commentsById[report.comment_id];
      var paperId = report.paper_id || (comment && comment.paper_id);
      return Object.assign({}, report, {
        paper_title: paperTitles[paperId],
        comment_body: comment && comment.body
      });
    });
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
      var reportState = null;
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
          reportState = { rows: [], error: "" };
          try {
            reportState.rows = await loadOpenReports();
          } catch (reportError) {
            reportState.error = reportError.message || "Supabase request failed.";
          }
        }
      }
      if (version !== loadVersion || userId !== (session && session.user.id)) return;
      papers = ownRows.concat(reviewRows || []);
      renderPapers(publicResult.data || [], ownRows, reviewRows, reportState);
      setStatus(reportState && reportState.error ? "Could not load reports: " + reportState.error : "");
    } catch (error) {
      if (version !== loadVersion) return;
      setStatus("Could not load papers: " + (error.message || "Supabase request failed."), true);
    }
  }

  async function loadPublicProfiles(ids) {
    var uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (!uniqueIds.length) return {};
    var result = await client().from("profiles")
      .select("id,username,display_name,avatar_url,is_public")
      .in("id", uniqueIds).eq("is_public", true);
    if (result.error) throw result.error;
    return (result.data || []).reduce(function (profiles, profile) {
      profiles[profile.id] = profile;
      return profiles;
    }, {});
  }

  function filteredFeedRows() {
    var query = feedView.querySelector("#paper-feed-search").value.trim().toLowerCase();
    if (!query) return feedRows;
    return feedRows.filter(function (paper) {
      var author = feedAuthors[paper.author_id];
      return [
        paper.title, paper.abstract, (paper.keywords || []).join(" "),
        paper.publication_year, author && author.display_name, author && author.username
      ].join(" ").toLowerCase().includes(query);
    });
  }

  async function renderFeed() {
    var list = feedView.querySelector("#paper-feed-list");
    var rows = filteredFeedRows();
    if (!rows.length) {
      list.innerHTML = '<p class="paper-muted">' + (feedRows.length
        ? "No loaded papers match your search. Load more papers to search older results."
        : "No published papers yet.") + "</p>";
      feedView.querySelector("#paper-feed-more").hidden = !feedHasMore;
      return;
    }
    var hydratedRows = await Promise.all(rows.map(async function (paper) {
      return {
        paper: paper,
        engagement: await loadPaperEngagement(paper.id)
      };
    }));
    list.innerHTML = hydratedRows.map(function (entry) {
      return publicPaperCard(entry.paper, entry.engagement);
    }).join("");
    feedView.querySelector("#paper-feed-more").hidden = !feedHasMore;
    hydratedRows.forEach(function (entry) {
      var root = list.querySelector('[data-paper-engagement="' + entry.paper.id + '"]');
      if (root) {
        renderPaperEngagement(entry.paper.id, root.parentElement || root);
      }
    });
  }

  async function loadFeedPage(reset) {
    if (feedLoading) return;
    if (reset) {
      feedRows = [];
      feedAuthors = {};
      feedOffset = 0;
      feedHasMore = true;
    }
    if (!feedHasMore) return;
    var version = routeVersion;
    var button = feedView.querySelector("#paper-feed-more");
    feedLoading = true;
    button.disabled = true;
    var feedStatus = feedView.querySelector("#paper-feed-status");
    feedStatus.classList.remove("error");
    feedStatus.textContent = "Loading published papers…";
    try {
      var result = await client().from("papers").select(PUBLIC_FIELDS)
        .eq("status", "Published").order("published_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false }).range(feedOffset, feedOffset + 23);
      if (result.error) throw result.error;
      var rows = result.data || [];
      var profiles = await loadPublicProfiles(rows.map(function (paper) { return paper.author_id; }));
      if (version !== routeVersion) return;
      feedAuthors = Object.assign(feedAuthors, profiles);
      feedRows = feedRows.concat(rows);
      feedOffset += rows.length;
      feedHasMore = rows.length === 24;
      await renderFeed();
      feedStatus.classList.remove("error");
      feedStatus.textContent =
        feedHasMore ? "Search covers loaded papers; load more to include older results." : "";
    } catch (error) {
      if (version !== routeVersion) return;
      feedStatus.textContent =
        "Could not load papers: " + (error.message || "Supabase request failed.");
      feedStatus.classList.add("error");
    } finally {
      feedLoading = false;
      button.disabled = false;
    }
  }

  function hideForPaperRoute() {
    Array.prototype.forEach.call(wrap.children, function (child) {
      if (child !== topBar && child !== feedView && child !== paperView) {
        if (!child.dataset.paperHidden) {
          child.dataset.paperHidden = child.hidden ? "already-hidden" : "shown";
        }
        child.hidden = true;
      }
    });
    feedView.hidden = true;
    paperView.hidden = false;
  }

  function leavePaperRoute() {
    routeVersion++;
    feedView.hidden = true;
    paperView.hidden = true;
    paperView.innerHTML = "";
    Array.prototype.forEach.call(wrap.children, function (child) {
      if (child.dataset.paperHidden) {
        child.hidden = child.dataset.paperHidden === "already-hidden";
        delete child.dataset.paperHidden;
      }
    });
  }

  async function openPaper(id, pushState) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return;
    }
    var version = ++routeVersion;
    hideForPaperRoute();
    paperView.innerHTML = '<div class="paper-page"><p class="paper-muted" role="status">Loading paper…</p></div>';
    var path = paperPath(id);
    if (pushState) window.history.pushState({ privcPaper: true }, "", path);
    window.scrollTo(0, 0);
    var result;
    try {
      result = await client().from("papers").select(PUBLIC_FIELDS)
        .eq("id", id).eq("status", "Published").maybeSingle();
      if (result.error) throw result.error;
    } catch (error) {
      if (version !== routeVersion) return;
      paperView.innerHTML = '<div class="paper-page"><button type="button" data-paper-back>Back to papers</button>' +
        '<p class="paper-muted error">Could not load the paper: ' +
        escapeHtml(error.message || "Supabase request failed.") + "</p></div>";
      return;
    }
    if (version !== routeVersion) return;
    if (!result.data) {
      paperView.innerHTML = '<div class="paper-page"><button type="button" data-paper-back>Back to papers</button>' +
        '<p class="paper-muted">This published paper could not be found.</p></div>';
      return;
    }

    var paper = result.data;
    var profileError = "";
    var authorMap = {};
    try {
      authorMap = await loadPublicProfiles([paper.author_id]);
    } catch (error) {
      profileError = "Author profile could not be loaded: " + (error.message || "Supabase request failed.");
    }
    if (version !== routeVersion) return;
    feedAuthors = Object.assign(feedAuthors, authorMap);
    var author = feedAuthors[paper.author_id];
    var detailEngagement = await loadPaperEngagement(paper.id);
    paperView.innerHTML = '<div class="paper-page"><button type="button" data-paper-back>Back to papers</button>' +
      '<article class="paper-detail"><div class="paper-feed-byline">' + publicAuthorMarkup(paper) +
      '<span class="paper-card-meta">' + escapeHtml(paper.publication_year || "Year not set") +
      ' · <span id="paper-detail-views">' + escapeHtml(Number(paper.view_count || 0).toLocaleString()) +
      '</span> views</span></div><h1>' + escapeHtml(paper.title) + '</h1>' +
      (paper.keywords && paper.keywords.length
        ? '<p class="paper-keywords"><b>Topics:</b> ' + escapeHtml(paper.keywords.join(", ")) + "</p>" : "") +
      '<section><h2>Abstract</h2><p class="paper-abstract">' +
      escapeHtml(paper.abstract || "No abstract was provided.") + '</p></section>' +
      paperEngagementMarkup(paper, detailEngagement) +
      '<button type="button" class="paper-action" data-report-paper="' + escapeHtml(paper.id) +
      '"' + (session ? "" : " hidden") + '>Report</button>' +
      '<div data-paper-report-feedback="' + escapeHtml(paper.id) + '" class="paper-status-message" role="status" aria-live="polite"></div>' +
      '<button type="button" class="pri" data-download="' + escapeHtml(paper.id) + '">Open PDF</button>' +
      '<p id="paper-detail-status" class="paper-status-message" role="status" aria-live="polite">' +
      escapeHtml(profileError) + '</p>' +
      '<section><h2>More from this author</h2><div id="paper-more-author" class="paper-list">' +
      '<p class="paper-muted">Loading more papers…</p></div></section></article></div>';
    detailStatus = paperView.querySelector("#paper-detail-status");
    if (profileError) detailStatus.classList.add("error");

    if (author && author.is_public) {
      try {
        var related = await client().from("papers").select(PUBLIC_FIELDS)
          .eq("author_id", paper.author_id).eq("status", "Published").neq("id", paper.id)
          .order("published_at", { ascending: false, nullsFirst: false }).limit(6);
        if (related.error) throw related.error;
        if (version !== routeVersion) return;
        var relatedRows = related.data || [];
        var relatedEngagement = await Promise.all(relatedRows.map(async function (paperItem) {
          return {
            paper: paperItem,
            engagement: await loadPaperEngagement(paperItem.id)
          };
        }));
        paperView.querySelector("#paper-more-author").innerHTML = relatedEngagement.length
          ? relatedEngagement.map(function (entry) {
              return publicPaperCard(entry.paper, entry.engagement);
            }).join("")
          : '<p class="paper-muted">No other published papers from this author yet.</p>';
        relatedEngagement.forEach(function (entry) {
          var root = paperView.querySelector('[data-paper-engagement="' + entry.paper.id + '"]');
          if (root) {
            renderPaperEngagement(entry.paper.id, root.parentElement || root);
          }
        });
      } catch (error) {
        if (version !== routeVersion) return;
        paperView.querySelector("#paper-more-author").innerHTML =
          '<p class="paper-muted error">Could not load more papers: ' +
          escapeHtml(error.message || "Supabase request failed.") + "</p>";
      }
    } else {
      paperView.querySelector("#paper-more-author").innerHTML =
        '<p class="paper-muted">The author’s public profile is unavailable.</p>';
    }

    try {
      var viewResult = await client().rpc("privc_record_paper_view", { p_paper_id: paper.id });
      if (viewResult.error) throw viewResult.error;
      if (version === routeVersion && paperView.querySelector("#paper-detail-views")) {
        paperView.querySelector("#paper-detail-views").textContent =
          Number(viewResult.data).toLocaleString();
      }
    } catch (error) {
      if (version !== routeVersion) return;
      detailStatus.textContent = [profileError,
        "Could not update view count: " + (error.message || "Supabase request failed.")]
        .filter(Boolean).join(" ");
      detailStatus.classList.add("error");
    }
    var engagementRoot = paperView.querySelector(".paper-engagement");
    if (engagementRoot) await renderPaperEngagement(paper.id, engagementRoot.parentElement || engagementRoot);
  }

  function handlePaperRoute() {
    var base = routeBase().replace(/\/$/, "");
    var path = window.location.pathname.slice(base.length);
    var match = path.match(/^\/?papers(?:\/([^/]+))?\/?$/);
    if (!match) {
      if (!feedView.hidden || !paperView.hidden) leavePaperRoute();
      return;
    }
    if (match[1]) {
      var id;
      try { id = decodeURIComponent(match[1]); }
      catch (error) { return; }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        routeVersion++;
        hideForPaperRoute();
        paperView.innerHTML = '<div class="paper-page"><button type="button" data-paper-back>Back to papers</button>' +
          '<p class="paper-muted">This paper link is not valid.</p></div>';
        return;
      }
      openPaper(id, false);
      return;
    }
    routeVersion++;
    hideForPaperRoute();
    feedView.hidden = false;
    paperView.hidden = true;
    if (!feedRows.length) loadFeedPage(true);
    else renderFeed();
    window.scrollTo(0, 0);
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
    dialog.querySelector("#paper-year").value = paper.publication_year || "";
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
    var publicationYear = Number(dialog.querySelector("#paper-year").value);
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
    if (!Number.isInteger(publicationYear) || publicationYear < 1000 || publicationYear > 9999) {
      setStatus("Enter a publication year between 1000 and 9999.", true);
      return;
    }
    try {
      setBusy(true);
      setStatus(editingPaper ? "Saving your changes…" : "Creating your draft…");
      var paper = editingPaper;
      if (paper) {
        var update = await client().from("papers").update({
          title: title, abstract: abstract, keywords: keywords, publication_year: publicationYear
        }).eq("id", paper.id).select(PRIVATE_FIELDS).single();
        if (update.error) throw update.error;
        paper = update.data;
      } else {
        var insert = await client().from("papers").insert({
          author_id: session.user.id, title: title, abstract: abstract, keywords: keywords,
          publication_year: publicationYear
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

  async function downloadPdf(id, output) {
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
      var target = output || status;
      target.textContent = "Could not open the PDF: " + (error.message || "Request failed.");
      target.classList.add("error");
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

  async function openReportForm(targetType, targetId, trigger) {
    var activeSession = await requireActiveSession();
    if (!activeSession) return;
    var host = trigger.parentElement;
    if (!host) return;
    var feedback = host.querySelector("[data-paper-report-feedback]");
    if (!feedback) {
      feedback = document.createElement("div");
      feedback.className = "paper-status-message";
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      host.appendChild(feedback);
    }
    feedback.classList.remove("error");
    feedback.textContent = "Checking your previous reports…";
    var alreadyReported = false;
    var timeoutId;
    try {
      var targetColumn = targetType === "paper" ? "paper_id" : "comment_id";
      var existing = await Promise.race([
        (async function () {
          return await client().from("paper_reports").select("id")
            .eq("reporter_id", activeSession.user.id)
            .eq(targetColumn, targetId)
            .maybeSingle();
        })(),
        new Promise(function (resolve, reject) {
          timeoutId = window.setTimeout(function () {
            var error = new Error("Checking previous reports timed out after 8 seconds.");
            error.code = "REPORT_CHECK_TIMEOUT";
            reject(error);
          }, 8000);
        })
      ]);
      if (existing.error) throw existing.error;
      if (existing.data) {
        alreadyReported = true;
        feedback.textContent = "Thanks for helping keep the community safe — you’ve already reported this " +
          (targetType === "paper" ? "paper." : "comment.");
      } else {
        feedback.textContent = "";
      }
    } catch (error) {
      console.error("Could not check previous reports:", error);
      feedback.textContent = error.code === "REPORT_CHECK_TIMEOUT"
        ? "Could not verify previous reports because the check timed out after 8 seconds. You can still submit a report."
        : "Could not verify previous reports. You can still submit a report.";
      feedback.classList.add("error");
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
      if (!alreadyReported) {
        var form = host.querySelector("[data-paper-report-form]");
        if (!form) {
          form = document.createElement("form");
          form.className = "paper-comment-form";
          form.setAttribute("data-paper-report-form", "");
          form.setAttribute("data-report-target-type", targetType);
          form.setAttribute("data-report-target-id", targetId);
          form.innerHTML = '<label class="paper-field">Reason<select data-report-reason required>' +
            '<option value="">Choose a reason</option><option value="spam">Spam</option>' +
            '<option value="abuse">Abuse</option><option value="plagiarism">Plagiarism</option>' +
            '<option value="other">Other</option></select></label>' +
            '<label class="paper-field">Note (optional)<textarea data-report-note rows="2" maxlength="2000"></textarea></label>' +
            '<div class="row"><button type="submit" class="pri">Send</button>' +
            '<button type="button" data-report-cancel>Cancel</button></div>';
          host.appendChild(form);
        }
      }
    }
  }

  async function submitReport(event) {
    var form = event.target.closest("[data-paper-report-form]");
    if (!form) return;
    event.preventDefault();
    var activeSession = await requireActiveSession();
    if (!activeSession) return;
    var reason = form.querySelector("[data-report-reason]").value;
    var note = String(form.querySelector("[data-report-note]").value || "").trim();
    var host = form.parentElement;
    var feedback = host.querySelector("[data-paper-report-feedback]");
    if (!feedback) {
      feedback = document.createElement("div");
      feedback.className = "paper-status-message";
      feedback.setAttribute("role", "status");
      host.appendChild(feedback);
    }
    if (!["spam", "abuse", "plagiarism", "other"].includes(reason)) {
      feedback.textContent = "Choose a reason for the report.";
      feedback.classList.add("error");
      return;
    }
    try {
      var targetType = form.dataset.reportTargetType;
      var targetId = form.dataset.reportTargetId;
      var report = {
        reporter_id: activeSession.user.id,
        target_type: targetType,
        reason: reason,
        note: note || null
      };
      report[targetType === "paper" ? "paper_id" : "comment_id"] = targetId;
      var result = await client().from("paper_reports").insert(report);
      if (result.error) {
        if (result.error.code === "23505") {
          feedback.textContent = "Thanks for helping keep the community safe — you’ve already reported this " +
            (targetType === "paper" ? "paper." : "comment.");
          feedback.classList.remove("error");
          form.remove();
          return;
        }
        throw result.error;
      }
      feedback.textContent = "Thank you. Your report has been submitted for review.";
      feedback.classList.remove("error");
      form.remove();
    } catch (error) {
      console.error("Could not submit the report:", error);
      feedback.textContent = "Could not submit the report: " + (error.message || "Supabase request failed.");
      feedback.classList.add("error");
    }
  }

  async function resolveReport(event) {
    var button = event.target.closest("[data-report-status]");
    if (!button || busy) return;
    var card = button.closest("[data-paper-report]");
    if (!card || !session || !session.user) return;
    var resolutionNote = String(card.querySelector("[data-report-resolution-note]").value || "").trim();
    try {
      setBusy(true);
      var result = await client().from("paper_reports").update({
        status: button.dataset.reportStatus,
        resolution_note: resolutionNote || null,
        resolved_by: session.user.id,
        resolved_at: new Date().toISOString()
      }).eq("id", card.dataset.paperReport).eq("status", "open").select("id").maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) throw new Error("This report is no longer open.");
      setStatus(button.dataset.reportStatus === "resolved" ? "Report resolved." : "Report dismissed.");
      await loadPapers();
    } catch (error) {
      setStatus("Could not update the report: " + (error.message || "Request failed."), true);
    } finally {
      setBusy(false);
    }
  }

  function handleReportClick(event) {
    var reportButton = event.target.closest("[data-report-paper], [data-report-comment]");
    if (reportButton) {
      var targetType = reportButton.hasAttribute("data-report-paper") ? "paper" : "comment";
      var targetId = targetType === "paper" ? reportButton.dataset.reportPaper : reportButton.dataset.reportComment;
      openReportForm(targetType, targetId, reportButton);
      return true;
    }
    var cancelButton = event.target.closest("[data-report-cancel]");
    if (cancelButton) {
      var form = cancelButton.closest("[data-paper-report-form]");
      if (form) form.remove();
      var feedback = cancelButton.closest(".paper-comment, .paper-detail, .paper-engagement");
      if (feedback) {
        var statusElement = feedback.querySelector("[data-paper-report-feedback]");
        if (statusElement) statusElement.textContent = "";
      }
      return true;
    }
    return false;
  }

  async function handleReportSubmit(event) {
    if (event.target.closest("[data-paper-report-form]")) await submitReport(event);
  }

  async function refreshVisibleCommentThreads() {
    var boxes = document.querySelectorAll(".paper-comment-box:not([hidden])");
    await Promise.all(Array.prototype.map.call(boxes, function (box) {
      return loadCommentThread(box.dataset.paperCommentBox, box);
    }));
  }

  function createInterface() {
    topBar = document.querySelector(".top");
    wrap = document.querySelector(".wrap");
    var menuItems = document.querySelector("#mnb .mg");
    if (!topBar || !wrap || !menuItems) throw new Error("The PRIVC Atlas page shell could not be found.");

    var openButton = document.createElement("button");
    openButton.type = "button";
    openButton.id = "papers-open";
    openButton.className = "mt";
    openButton.style.setProperty("--c", "#be185d");
    openButton.innerHTML = "Papers and articles<small>Published research and submissions</small>";
    openButton.setAttribute("aria-label", "Open the papers feed");
    menuItems.appendChild(openButton);

    feedView = document.createElement("section");
    feedView.id = "paper-feed-page";
    feedView.className = "paper-page";
    feedView.hidden = true;
    feedView.innerHTML = '<div class="paper-feed-head"><div><h1>Papers</h1>' +
      '<p class="paper-muted">Published research from the PRIVC Atlas community.</p></div>' +
      '<button type="button" id="paper-manage-open">Submit or manage papers</button></div>' +
      '<label class="paper-field" for="paper-feed-search">Search papers, authors, topics or year' +
      '<input id="paper-feed-search" type="search" autocomplete="off"></label>' +
      '<p id="paper-feed-status" class="paper-status-message" role="status" aria-live="polite"></p>' +
      '<div id="paper-feed-list" class="paper-list"></div>' +
      '<button type="button" id="paper-feed-more">Load more papers</button>';
    wrap.appendChild(feedView);

    paperView = document.createElement("section");
    paperView.id = "paper-detail-page";
    paperView.className = "paper-route";
    paperView.hidden = true;
    wrap.appendChild(paperView);

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
      '<label class="paper-field">Publication year<input id="paper-year" type="number" min="1000" max="9999" required></label>' +
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
      '<section id="paper-report-section" hidden><h3>Reports</h3>' +
      '<p class="paper-muted">Open paper and comment reports for reviewer action.</p>' +
      '<div id="paper-report-list" class="paper-list"></div></section>' +
      '<p id="paper-status" class="paper-status-message" role="status" aria-live="polite"></p></div></dialog>';
    document.body.appendChild(root);
    dialog = document.getElementById("papers-dialog");
    status = document.getElementById("paper-status");

    openButton.addEventListener("click", function () {
      window.history.pushState({ privcPaper: true }, "", routeBase() + "papers");
      handlePaperRoute();
    });
    feedView.querySelector("#paper-manage-open").addEventListener("click", function () {
      dialog.showModal();
      loadPapers();
    });
    feedView.querySelector("#paper-feed-search").addEventListener("input", renderFeed);
    feedView.querySelector("#paper-feed-more").addEventListener("click", function () {
      loadFeedPage(false);
    });
    feedView.addEventListener("click", function (event) {
      if (handleReportClick(event)) return;
      var paperLink = event.target.closest("[data-paper-detail]");
      if (paperLink) {
        event.preventDefault();
        openPaper(paperLink.dataset.paperDetail, true);
      }
    });
    feedView.addEventListener("submit", handleReportSubmit);
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
      if (event.target.closest("[data-report-status]")) {
        resolveReport(event);
        return;
      }
      var editButton = event.target.closest("[data-edit]");
      if (editButton) {
        editPaper(editButton.dataset.edit);
        dialog.querySelector("#paper-cancel-edit").hidden = false;
        return;
      }
      var downloadButton = event.target.closest("[data-download]");
      if (downloadButton) {
        downloadPdf(downloadButton.dataset.download, status);
        return;
      }
      reviewPaper(event);
    });
    paperView.addEventListener("click", function (event) {
      if (handleReportClick(event)) return;
      var backButton = event.target.closest("[data-paper-back]");
      if (backButton) {
        if (window.history.state && window.history.state.privcPaper) window.history.back();
        else {
          window.history.replaceState(null, "", routeBase());
          leavePaperRoute();
        }
        return;
      }
      var paperLink = event.target.closest("[data-paper-detail]");
      if (paperLink) {
        event.preventDefault();
        openPaper(paperLink.dataset.paperDetail, true);
        return;
      }
      var downloadButton = event.target.closest("[data-download]");
      if (downloadButton) downloadPdf(downloadButton.dataset.download, detailStatus);
    });
    paperView.addEventListener("submit", handleReportSubmit);
    window.addEventListener("popstate", handlePaperRoute);

    window.addEventListener("privc:authchange", function (event) {
      session = event.detail && event.detail.session || null;
      loadVersion++;
      paperView.querySelectorAll("[data-report-paper]").forEach(function (button) {
        button.hidden = !session;
      });
      refreshVisibleCommentThreads();
      var accountSection = dialog.querySelector("#paper-account-section");
      var uploadSection = dialog.querySelector("#paper-upload-section");
      accountSection.hidden = !session;
      uploadSection.hidden = !session;
      if (dialog.open) loadPapers();
    });
    handlePaperRoute();
  }

  document.addEventListener("DOMContentLoaded", function () {
    try {
      createInterface();
    } catch (error) {
      console.error("Paper workflow could not initialize:", error);
    }
  });
})();
