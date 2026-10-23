(function () {
  "use strict";

  var config = window.PRIVC_CONFIG;
  var client = null;
  var initError = "";

  if (!config || !config.supabaseUrl || !config.supabasePublishableKey) {
    initError = "Supabase URL or publishable key is missing from config.js.";
  } else if (!window.supabase || typeof window.supabase.createClient !== "function") {
    initError = "Supabase Auth could not load. Check the network connection and the Supabase JS script.";
  } else {
    try {
      client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
        auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
      });
    } catch (error) {
      initError = "Supabase Auth could not initialize: " + error.message;
    }
  }

  function requireClient() {
    if (!client) throw new Error(initError || "Supabase Auth is unavailable.");
    return client;
  }

  function getProfileAvatar(profile) {
    if (!profile || !profile.id || !profile.avatar_url) return null;
    try {
      var storage = requireClient().storage.from("profile-avatars");
      var marker = new URL(storage.getPublicUrl(profile.id + "/__avatar_marker__").data.publicUrl);
      var candidate = new URL(profile.avatar_url);
      var directory = marker.pathname.slice(0, -"/__avatar_marker__".length);
      if (candidate.origin !== marker.origin || candidate.search || candidate.hash ||
          !candidate.pathname.startsWith(directory + "/")) return null;
      var filename = decodeURIComponent(candidate.pathname.slice(directory.length + 1));
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename)) return null;
      var expectedUrl = storage.getPublicUrl(profile.id + "/" + filename).data.publicUrl;
      if (candidate.href !== new URL(expectedUrl).href) return null;
      return { url: expectedUrl, path: profile.id + "/" + filename };
    } catch (error) {
      return null;
    }
  }

  function siteBasePath() {
    var path = window.location.pathname;
    var routed = path.match(/^(.*\/)(?:u\/[^/]+|papers(?:\/[^/]+)?|auth\/callback)\/?$/);
    if (routed) return routed[1] || "/";
    if (/\/index\.html$/i.test(path)) return path.slice(0, path.lastIndexOf("/") + 1);
    if (path.endsWith("/")) return path;
    return path.slice(0, path.lastIndexOf("/") + 1) || "/";
  }

  function authRedirectUrl() {
    return new URL("auth/callback", window.location.origin + siteBasePath()).href;
  }

  async function signUp(details) {
    return requireClient().auth.signUp({
      email: details.email,
      password: details.password,
      options: {
        emailRedirectTo: authRedirectUrl(),
        data: { username: details.username, display_name: details.displayName }
      }
    });
  }

  async function signIn(email, password) {
    return requireClient().auth.signInWithPassword({ email: email, password: password });
  }

  async function signOut() {
    return requireClient().auth.signOut();
  }

  async function sendPasswordReset(email) {
    return requireClient().auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl() + "?reset=1" });
  }

  async function updatePassword(password) {
    return requireClient().auth.updateUser({ password: password });
  }

  async function signInWithProvider(provider) {
    return requireClient().auth.signInWithOAuth({
      provider: provider,
      options: { redirectTo: authRedirectUrl() }
    });
  }

  async function deleteAccount() {
    var response = await requireClient().functions.invoke(
      config.accountDeleteFunction || "delete-account",
      { method: "POST" }
    );
    if (response.error) throw response.error;
    return response.data;
  }

  function emitAuthState(event, session, error) {
    window.setTimeout(function () {
      window.dispatchEvent(new CustomEvent("privc:authchange", {
        detail: { event: event, session: session || null, error: error || null }
      }));
    }, 0);
  }

  window.PRIVC_AUTH = {
    client: client,
    initError: initError,
    isConfigured: Boolean(client),
    siteBasePath: siteBasePath,
    authRedirectUrl: authRedirectUrl,
    signUp: signUp,
    signIn: signIn,
    signOut: signOut,
    sendPasswordReset: sendPasswordReset,
    updatePassword: updatePassword,
    signInWithProvider: signInWithProvider,
    deleteAccount: deleteAccount,
    getProfileAvatar: getProfileAvatar
  };

  document.addEventListener("DOMContentLoaded", function () {
    if (!client) {
      emitAuthState("UNAVAILABLE", null, new Error(initError));
      return;
    }
    client.auth.onAuthStateChange(function (event, session) {
      emitAuthState(event, session);
      if (event === "PASSWORD_RECOVERY") {
        window.dispatchEvent(new CustomEvent("privc:password-recovery"));
      }
    });
  });
})();
