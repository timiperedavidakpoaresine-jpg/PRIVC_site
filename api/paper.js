const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function errorPage(res, status, message) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(message)}</title></head><body><main><h1>${escapeHtml(message)}</h1></main></body></html>`);
}

function restUrl(baseUrl, table, params) {
  const url = new URL(`/rest/v1/${table}`, baseUrl);
  url.search = new URLSearchParams(params).toString();
  return url;
}

async function fetchRows(baseUrl, anonKey, table, params) {
  const response = await fetch(restUrl(baseUrl, table, params), {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Supabase ${table} query failed with ${response.status}`);
  }
  return response.json();
}

module.exports = async function paperPage(req, res) {
  const paperId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (req.method !== "GET" || typeof paperId !== "string" || !UUID_PATTERN.test(paperId)) {
    return errorPage(res, req.method === "GET" ? 404 : 405, "Paper not found");
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const siteUrlValue = process.env.SITE_URL;
  if (!supabaseUrl || !anonKey || !siteUrlValue) {
    console.error("Paper page is missing required environment configuration");
    return errorPage(res, 503, "Paper pages are temporarily unavailable");
  }

  let supabaseBase;
  let siteBase;
  try {
    supabaseBase = new URL(supabaseUrl);
    siteBase = new URL(siteUrlValue);
    if (!["http:", "https:"].includes(supabaseBase.protocol) ||
        !["http:", "https:"].includes(siteBase.protocol)) {
      throw new Error("Unsupported URL protocol");
    }
  } catch {
    console.error("Paper page URL configuration is invalid");
    return errorPage(res, 503, "Paper pages are temporarily unavailable");
  }

  try {
    const papers = await fetchRows(supabaseBase, anonKey, "papers", {
      select: "id,title,abstract,keywords,publication_year,published_at,created_at,doi",
      id: `eq.${paperId}`,
      status: "eq.Published",
      limit: "1",
    });
    const paper = papers[0];
    if (!paper) return errorPage(res, 404, "Paper not found");

    const authorRows = await fetchRows(supabaseBase, anonKey, "paper_authors", {
      select: "author_id,author_order",
      paper_id: `eq.${paperId}`,
      order: "author_order.asc",
    });

    let profiles = [];
    if (authorRows.length > 0) {
      const authorIds = authorRows.map((author) => author.author_id);
      profiles = await fetchRows(supabaseBase, anonKey, "profiles", {
        select: "id,display_name",
        id: `in.(${authorIds.join(",")})`,
      });
    }

    const namesById = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
    const authors = authorRows.map((author, index) => ({
      name: String(namesById.get(author.author_id) || "").trim() || `Author ${index + 1}`,
    }));
    const keywords = Array.isArray(paper.keywords) ? paper.keywords : [];
    const year = paper.publication_year
      ? String(paper.publication_year)
      : String(paper.published_at || paper.created_at || "").slice(0, 4);
    const canonicalUrl = new URL(`/papers/${paperId}`, siteBase.origin).toString();
    const pdfUrl = new URL(`/functions/v1/paper-public-pdf/${paperId}`, supabaseBase.origin).toString();
    const requestHost = String(req.headers.host || "").toLowerCase();
    const isCanonicalHost = requestHost === siteBase.host.toLowerCase();
    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "ScholarlyArticle",
      headline: paper.title,
      abstract: paper.abstract || "",
      author: authors.map((author) => ({ "@type": "Person", name: author.name })),
      ...(year ? { datePublished: year } : {}),
      keywords,
      url: canonicalUrl,
      ...(paper.doi ? { identifier: `https://doi.org/${encodeURIComponent(paper.doi)}` } : {}),
    };

    const keywordsHtml = keywords.map((keyword) => `<li>${escapeHtml(keyword)}</li>`).join("");
    const authorsHtml = authors.map((author) => `<li>${escapeHtml(author.name)}</li>`).join("");
    const doiHtml = paper.doi
      ? `<p><strong>DOI:</strong> <a href="https://doi.org/${escapeHtml(encodeURIComponent(paper.doi))}">${escapeHtml(paper.doi)}</a></p>`
      : "";

    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(paper.title)} | PRIVC</title>
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  ${isCanonicalHost ? "" : '<meta name="robots" content="noindex, nofollow">'}
  <meta name="citation_title" content="${escapeHtml(paper.title)}">
  ${authors.map((author) => `<meta name="citation_author" content="${escapeHtml(author.name)}">`).join("\n  ")}
  ${year ? `<meta name="citation_publication_date" content="${escapeHtml(year)}">` : ""}
  <meta name="citation_pdf_url" content="${escapeHtml(pdfUrl)}">
  <meta name="citation_abstract_html_url" content="${escapeHtml(canonicalUrl)}">
  <script type="application/ld+json">${safeJson(jsonLd)}</script>
  <style>
    body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:860px;margin:0 auto;padding:24px;color:#172b3e}
    h1{line-height:1.25} .muted{color:#536476} .abstract{white-space:pre-wrap}
    li{margin:.2em 0} a{color:#087d96}
  </style>
</head>
<body>
  <main>
    <p><a href="/">PRIVC Atlas</a> / Published paper</p>
    <article>
      <h1>${escapeHtml(paper.title)}</h1>
      ${year ? `<p class="muted"><strong>Year:</strong> ${escapeHtml(year)}</p>` : ""}
      <h2>Authors</h2>
      <ul>${authorsHtml}</ul>
      <h2>Abstract</h2>
      <p class="abstract">${escapeHtml(paper.abstract || "")}</p>
      ${keywords.length ? `<h2>Keywords</h2><ul>${keywordsHtml}</ul>` : ""}
      ${doiHtml}
      <p><a href="${escapeHtml(pdfUrl)}">Read or download the PDF</a></p>
    </article>
  </main>
</body>
</html>`;

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=0");
    if (!isCanonicalHost) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.end(html);
  } catch (error) {
    console.error("Unable to render published paper page", error);
    errorPage(res, 502, "Paper pages are temporarily unavailable");
  }
};
