(function () {
  "use strict";

  var config = Object.freeze({
    supabaseUrl: "https://dcwxfgmlnyqvkdnmxxcg.supabase.co",
    supabasePublishableKey: "sb_publishable_bYg0UelCpqCoy8Ta5YLttg_oDaTTSCJ",
    accountDeleteFunction: "delete-account"
  });

  window.PRIVC_CONFIG = config;
  window.ATLAS_DB = Object.freeze({
    url: config.supabaseUrl,
    key: config.supabasePublishableKey
  });
})();
