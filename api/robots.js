function textResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300");
  res.end(body);
}

module.exports = function robots(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return textResponse(res, 405, "Method not allowed\n");
  }

  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) {
    console.error("Robots file is missing SITE_URL configuration");
    return textResponse(res, 503, "Robots file is temporarily unavailable\n");
  }

  let siteBase;
  try {
    siteBase = new URL(siteUrl);
    if (!["http:", "https:"].includes(siteBase.protocol)) {
      throw new Error("Unsupported URL protocol");
    }
  } catch (error) {
    console.error("Robots file SITE_URL configuration is invalid", error);
    return textResponse(res, 503, "Robots file is temporarily unavailable\n");
  }

  return textResponse(
    res,
    200,
    `User-agent: *\nAllow: /\n\nSitemap: ${siteBase.origin}/sitemap.xml\n`
  );
};
