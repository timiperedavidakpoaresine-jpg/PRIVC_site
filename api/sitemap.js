function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300");
  res.end(body);
}

function configuration() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const siteUrl = process.env.SITE_URL;
  if (!supabaseUrl || !anonKey || !siteUrl) {
    throw new Error("Sitemap is missing required environment configuration");
  }

  const supabaseBase = new URL(supabaseUrl);
  const siteBase = new URL(siteUrl);
  if (!["http:", "https:"].includes(supabaseBase.protocol) ||
      !["http:", "https:"].includes(siteBase.protocol)) {
    throw new Error("Sitemap URL configuration is invalid");
  }

  return { supabaseBase, anonKey, siteBase };
}

async function fetchPublishedPapers(supabaseBase, anonKey) {
  const papers = [];
  const pageSize = 1000;

  for (let offset = 0; ; offset += pageSize) {
    const url = new URL("/rest/v1/papers", supabaseBase);
    url.search = new URLSearchParams({
      select: "id,published_at",
      status: "eq.Published",
      order: "id.asc",
      limit: String(pageSize),
      offset: String(offset),
    }).toString();

    const response = await fetch(url, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Supabase published-paper query failed with ${response.status}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) {
      throw new Error("Supabase returned an invalid published-paper response");
    }
    papers.push(...rows);
    if (rows.length < pageSize) return papers;
  }
}

module.exports = async function sitemap(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return xmlResponse(res, 405, "<error>Method not allowed</error>");
  }

  try {
    const { supabaseBase, anonKey, siteBase } = configuration();
    const papers = await fetchPublishedPapers(supabaseBase, anonKey);
    const entries = papers.map((paper) => {
      const url = new URL(`/papers/${encodeURIComponent(paper.id)}`, siteBase.origin).toString();
      const publishedDate = paper.published_at
        ? new Date(paper.published_at).toISOString()
        : "";
      return `  <url>\n    <loc>${escapeXml(url)}</loc>${publishedDate ? `\n    <lastmod>${escapeXml(publishedDate)}</lastmod>` : ""}\n  </url>`;
    });

    return xmlResponse(
      res,
      200,
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>`
    );
  } catch (error) {
    console.error("Unable to generate sitemap", error);
    return xmlResponse(res, 502, "<error>Sitemap is temporarily unavailable</error>");
  }
};
