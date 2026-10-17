(function () {
  "use strict";

  var SELECT_FIELDS = "id,username,display_name,affiliation,country,bio,research_interests,orcid,website,avatar_url,is_public,created_at,updated_at";
  var state = { session: null, profile: null, busy: false, route: false };
  var wrap;
  var topBar;
  var profileView;
  var accountDialog;
  var statusElement;
  var authMode = "signup";
  var recoveryMode = false;
  var authChangeVersion = 0;
  var profileRouteVersion = 0;

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
        "Supabase Auth is not ready. Check config.js and the network.");
    }
    return window.PRIVC_AUTH.client;
  }

  function setStatus(message, isError) {
    if (!statusElement) return;
    statusElement.textContent = message;
    statusElement.classList.toggle("error", Boolean(isError));
  }

  function setBusy(busy) {
    state.busy = busy;
    document.querySelectorAll("#account-dialog button:not(#account-close),#profile-editor-form button:not(#profile-editor-cancel)")
      .forEach(function (button) { button.disabled = busy; });
  }

  function routeBase() {
    return window.PRIVC_AUTH ? window.PRIVC_AUTH.siteBasePath() : "/";
  }

  function profileHref(username) {
    return routeBase() + "u/" + encodeURIComponent(username);
  }

  function avatarMarkup(profile) {
    var avatar = String(profile.avatar_url || "").trim();
    var safeUrl = "";
    try {
      var parsed = new URL(avatar, window.location.href);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") safeUrl = parsed.href;
    } catch (error) {
      safeUrl = "";
    }
    if (safeUrl) return '<div class="profile-avatar"><img src="' + escapeHtml(safeUrl) +
      '" alt="' + escapeHtml(profile.display_name || profile.username) + ' profile photo"></div>';
    var initial = String(profile.display_name || profile.username || "?").trim().slice(0, 1).toUpperCase();
    return '<div class="profile-avatar" aria-label="Profile photo placeholder">' + escapeHtml(initial) + "</div>";
  }

  function createInterface() {
    wrap = document.querySelector(".wrap");
    topBar = document.querySelector(".top");
    if (!wrap || !topBar) throw new Error("The PRIVC Atlas page shell could not be found.");

    var accountButton = document.createElement("button");
    accountButton.type = "button";
    accountButton.id = "account-open";
    accountButton.setAttribute("aria-haspopup", "dialog");
    accountButton.setAttribute("aria-controls", "account-dialog");
    accountButton.textContent = "Sign in / Join";
    document.getElementById("mb").insertAdjacentElement("afterend", accountButton);

    var root = document.createElement("div");
    root.innerHTML = '<dialog id="account-dialog" class="account-dialog" aria-labelledby="account-title">' +
      '<div class="account-dialog-inner"><div class="account-dialog-head"><h2 id="account-title">PRIVC Atlas account</h2>' +
      '<button type="button" id="account-close" aria-label="Close account dialog">Close</button></div>' +
      '<section id="account-auth-panel"><p class="account-muted">Create a researcher profile or sign in to your existing account.</p>' +
      '<form id="account-auth-form" novalidate><div class="account-fields">' +
      '<label class="account-field">Email<input id="account-email" type="email" autocomplete="email" required></label>' +
      '<label class="account-field">Password<input id="account-password" type="password" minlength="8" autocomplete="current-password" required></label>' +
      '<div id="account-signup-fields" class="account-fields">' +
      '<label class="account-field">Display name<input id="account-display-name" autocomplete="name" maxlength="100"></label>' +
      '<label class="account-field">Username<input id="account-username" autocomplete="username" minlength="3" maxlength="32" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}" aria-describedby="account-username-help">' +
      '<small id="account-username-help">3–32 characters: letters, numbers, underscore or hyphen.</small></label></div></div>' +
      '<div class="account-dialog-actions"><button type="submit" class="pri" id="account-submit">Create account</button>' +
      '<button type="button" id="account-reset">Reset password</button></div></form>' +
      '<button type="button" id="account-mode-toggle" class="account-mode-toggle">Already have an account? Sign in</button>' +
      '<div class="account-provider-row"><button type="button" data-provider="google">Continue with Google</button>' +
      '<button type="button" data-provider="orcid">Continue with ORCID</button></div></section>' +
      '<section id="account-user-panel" hidden><p id="account-greeting"></p><div class="account-state-actions">' +
      '<button type="button" id="account-my-profile">View my profile</button>' +
      '<button type="button" id="account-edit-profile">Edit profile</button>' +
      '<button type="button" id="account-logout">Sign out</button>' +
      '<button type="button" id="account-delete">Delete account</button></div></section>' +
      '<section id="account-recovery-panel" hidden><label class="account-field">New password' +
      '<input id="account-new-password" type="password" autocomplete="new-password" minlength="8"></label>' +
      '<button type="button" id="account-update-password" class="pri">Update password</button></section>' +
      '<p id="account-status" class="account-status" role="status" aria-live="polite"></p></div></dialog>' +
      '<dialog id="profile-editor-dialog" class="profile-editor-dialog" aria-labelledby="profile-editor-title">' +
      '<form id="profile-editor-form" novalidate><h2 id="profile-editor-title">Edit profile</h2>' +
      '<div class="profile-editor-fields"><label class="account-field">Display name<input id="profile-display-name" maxlength="100" required></label>' +
      '<label class="account-field">Username<input id="profile-username" minlength="3" maxlength="32" required></label>' +
      '<label class="account-field">Affiliation<input id="profile-affiliation" maxlength="160"></label>' +
      '<label class="account-field">Country<input id="profile-country" maxlength="100"></label>' +
      '<label class="account-field">ORCID<input id="profile-orcid" placeholder="0000-0000-0000-0000"></label>' +
      '<label class="account-field">Website<input id="profile-website" type="url" placeholder="https://example.org"></label>' +
      '<label class="account-field">Photo URL<input id="profile-avatar" type="url" placeholder="https://example.org/photo.jpg">' +
      '<small>Image uploads will be added after the existing Storage setup is inspected.</small></label>' +
      '<label class="account-field">Research interests<input id="profile-interests" placeholder="climate policy, health"></label></div>' +
      '<label class="account-field">Biography<textarea id="profile-bio" rows="5" maxlength="3000"></textarea></label>' +
      '<label class="account-field"><input id="profile-public" type="checkbox"> Make my profile public</label>' +
      '<p id="profile-editor-error" class="account-status" role="alert" aria-live="assertive"></p>' +
      '<div class="profile-editor-actions"><button type="button" id="profile-editor-cancel">Cancel</button>' +
      '<button type="submit" class="pri">Save profile</button></div></form></dialog>';
    document.body.appendChild(root);
    accountDialog = document.getElementById("account-dialog");
    statusElement = document.getElementById("account-status");

    profileView = document.createElement("section");
    profileView.id = "community-profile-view";
    profileView.className = "profile-page";
    profileView.hidden = true;
    profileView.setAttribute("aria-live", "polite");
    wrap.appendChild(profileView);

    accountButton.addEventListener("click", function () {
      accountDialog.showModal();
      document.getElementById("account-email").focus();
    });
    document.getElementById("account-close").addEventListener("click", function () { accountDialog.close(); });
    accountDialog.addEventListener("click", function (event) {
      if (event.target === accountDialog) accountDialog.close();
    });
    document.getElementById("account-mode-toggle").addEventListener("click", toggleAuthMode);
    document.getElementById("account-auth-form").addEventListener("submit", submitAuth);
    document.getElementById("account-reset").addEventListener("click", resetPassword);
    document.querySelectorAll("#account-auth-panel [data-provider]").forEach(function (button) {
      button.addEventListener("click", function () { oauthLogin(button.dataset.provider); });
    });
    document.getElementById("account-logout").addEventListener("click", logout);
    var globalSignOut = document.getElementById("so");
    if (globalSignOut) {
      globalSignOut.addEventListener("click", function (event) {
        event.preventDefault();
        logout();
      });
    }
    document.getElementById("account-delete").addEventListener("click", deleteAccount);
    document.getElementById("account-my-profile").addEventListener("click", function () {
      if (state.profile) openProfile(state.profile.username, true);
      else setStatus("Your profile is not available yet. Complete the profile migration and try again.", true);
    });
    document.getElementById("account-edit-profile").addEventListener("click", editProfile);
    document.getElementById("account-update-password").addEventListener("click", updatePassword);
    document.getElementById("profile-editor-form").addEventListener("submit", saveProfile);
    document.getElementById("profile-editor-cancel").addEventListener("click", function () {
      document.getElementById("profile-editor-dialog").close();
    });

    window.addEventListener("privc:authchange", onAuthChange);
    window.addEventListener("privc:password-recovery", function () {
      recoveryMode = true;
      document.getElementById("account-auth-panel").hidden = true;
      document.getElementById("account-user-panel").hidden = true;
      document.getElementById("account-recovery-panel").hidden = false;
      accountDialog.showModal();
      setStatus("Choose a new password for your account.");
      document.getElementById("account-new-password").focus();
    });
    window.addEventListener("popstate", handleProfileRoute);
    document.addEventListener("click", function (event) {
      var link = event.target.closest("a[data-profile-username]");
      if (!link) return;
      event.preventDefault();
      openProfile(link.dataset.profileUsername, true);
    });
    handleProfileRoute();
  }

  function toggleAuthMode() {
    authMode = authMode === "signup" ? "signin" : "signup";
    document.getElementById("account-signup-fields").hidden = authMode !== "signup";
    document.getElementById("account-password").autocomplete = authMode === "signup" ? "new-password" : "current-password";
    document.getElementById("account-submit").textContent = authMode === "signup" ? "Create account" : "Sign in";
    document.getElementById("account-mode-toggle").textContent = authMode === "signup"
      ? "Already have an account? Sign in"
      : "New to PRIVC Atlas? Create an account";
    setStatus("");
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (state.busy) return;
    var emailInput = document.getElementById("account-email");
    var email = emailInput.value.trim();
    var password = document.getElementById("account-password").value;
    try {
      setBusy(true);
      setStatus("");
      if (!email || emailInput.validity.typeMismatch) {
        throw new Error("Enter a valid email address.");
      }
      if (!password) throw new Error("Enter your password.");
      if (authMode === "signup") {
        var username = document.getElementById("account-username").value.trim().toLowerCase();
        var displayName = document.getElementById("account-display-name").value.trim();
        if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)) throw new Error("Choose a username with 3–32 letters, numbers, underscores or hyphens.");
        if (!displayName) throw new Error("Enter the name to show on your public profile.");
        if (password.length < 8) throw new Error("Use a password with at least 8 characters.");
        var signup = await window.PRIVC_AUTH.signUp({
          email: email, password: password, username: username, displayName: displayName
        });
        if (signup.error) throw signup.error;
        setStatus(signup.data.session
          ? "Account created and signed in."
          : "Account created. Check your email to verify the address before signing in.");
        if (signup.data.session) accountDialog.close();
      } else {
        var login = await window.PRIVC_AUTH.signIn(email, password);
        if (login.error) throw login.error;
        setStatus("Signed in.");
        accountDialog.close();
      }
    } catch (error) {
      setStatus(error.message || "Authentication failed. Please try again.", true);
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (state.busy) return;
    var emailInput = document.getElementById("account-email");
    var email = emailInput.value.trim();
    if (!email || emailInput.validity.typeMismatch) {
      setStatus("Enter a valid email address first.", true);
      emailInput.focus();
      return;
    }
    try {
      setBusy(true);
      var result = await window.PRIVC_AUTH.sendPasswordReset(email);
      if (result.error) throw result.error;
      setStatus("If an account exists for that address, a password reset email is on its way.");
    } catch (error) {
      setStatus(error.message || "Password reset could not be sent.", true);
    } finally {
      setBusy(false);
    }
  }

  async function updatePassword() {
    if (state.busy) return;
    var password = document.getElementById("account-new-password").value;
    if (password.length < 8) {
      setStatus("Use a new password with at least 8 characters.", true);
      return;
    }
    try {
      setBusy(true);
      var result = await window.PRIVC_AUTH.updatePassword(password);
      if (result.error) throw result.error;
      recoveryMode = false;
      document.getElementById("account-recovery-panel").hidden = true;
      accountDialog.close();
      setStatus("Password updated.");
    } catch (error) {
      setStatus(error.message || "Password could not be updated.", true);
    } finally {
      setBusy(false);
    }
  }

  async function oauthLogin(provider) {
    if (state.busy) return;
    try {
      setBusy(true);
      var result = await window.PRIVC_AUTH.signInWithProvider(provider);
      if (result.error) throw result.error;
    } catch (error) {
      setStatus(error.message || provider + " sign-in is not configured.", true);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (state.busy) return;
    try {
      setBusy(true);
      var result = await window.PRIVC_AUTH.signOut();
      if (result.error) throw result.error;
      accountDialog.close();
    } catch (error) {
      setStatus(error.message || "Sign out failed.", true);
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (state.busy) return;
    var confirmation = window.confirm("Permanently delete your PRIVC Atlas account and profile? This cannot be undone.");
    if (!confirmation) return;
    try {
      setBusy(true);
      await window.PRIVC_AUTH.deleteAccount();
      await window.PRIVC_AUTH.signOut();
      accountDialog.close();
      setStatus("Account deleted.");
      if (state.route) leaveProfileRoute();
    } catch (error) {
      setStatus("Account deletion failed: " + (error.message || "The delete-account function may not be deployed yet."), true);
    } finally {
      setBusy(false);
    }
  }

  async function onAuthChange(event) {
    var detail = event.detail || {};
    var previousUserId = state.session && state.session.user && state.session.user.id;
    state.session = detail.session;
    var userId = state.session && state.session.user && state.session.user.id;
    var changeVersion = ++authChangeVersion;
    var accountButton = document.getElementById("account-open");
    var globalSignOut = document.getElementById("so");
    if (accountButton) accountButton.textContent = state.session ? "My account" : "Sign in / Join";
    if (globalSignOut) globalSignOut.hidden = !state.session;
    document.getElementById("account-auth-panel").hidden = Boolean(state.session) || recoveryMode;
    document.getElementById("account-user-panel").hidden = !state.session || recoveryMode;
    document.getElementById("account-recovery-panel").hidden = !recoveryMode;
    if (detail.error) setStatus(detail.error.message || "Could not restore the sign-in session.", true);
    if (!state.session) {
      state.profile = null;
      var chip = document.getElementById("chip");
      if (chip) chip.textContent = "Guest · Free Atlas";
      document.getElementById("account-greeting").textContent = "";
      if (detail.event === "UNAVAILABLE") setStatus(detail.error.message, true);
      if (state.route && previousUserId !== userId) handleProfileRoute();
      return;
    }
    try {
      var profile = await getProfileById(state.session.user.id);
      if (changeVersion !== authChangeVersion) return;
      state.profile = profile;
      document.getElementById("account-greeting").textContent =
        "Signed in as " + (state.profile ? state.profile.display_name : state.session.user.email || "researcher");
      if (!state.profile) setStatus("Signed in, but the profile is not ready. Apply the reviewed profiles migration.", true);
      var chipText = document.getElementById("chip");
      if (chipText) chipText.textContent = "Researcher · " +
        (state.profile ? "@" + state.profile.username : state.session.user.email);
      if (state.route && previousUserId !== userId) handleProfileRoute();
    } catch (error) {
      if (changeVersion !== authChangeVersion) return;
      setStatus("Signed in, but profile loading failed: " + error.message, true);
    }
  }

  async function getProfileById(id) {
    var result = await client().from("profiles").select(SELECT_FIELDS).eq("id", id).maybeSingle();
    if (result.error) throw result.error;
    return result.data;
  }

  async function getProfileByUsername(username) {
    var result = await client().from("profiles").select(SELECT_FIELDS)
      .eq("username", String(username).toLowerCase()).maybeSingle();
    if (result.error) throw result.error;
    return result.data;
  }

  async function saveProfileData(id, profile) {
    var result = await client().from("profiles").update(profile).eq("id", id)
      .select(SELECT_FIELDS).single();
    if (result.error) throw result.error;
    return result.data;
  }

  function editProfile() {
    if (!state.profile) {
      setStatus("Your profile is not available yet. Complete the profile migration and try again.", true);
      return;
    }
    var profile = state.profile;
    document.getElementById("profile-display-name").value = profile.display_name || "";
    document.getElementById("profile-username").value = profile.username || "";
    document.getElementById("profile-affiliation").value = profile.affiliation || "";
    document.getElementById("profile-country").value = profile.country || "";
    document.getElementById("profile-orcid").value = profile.orcid || "";
    document.getElementById("profile-website").value = profile.website || "";
    document.getElementById("profile-avatar").value = profile.avatar_url || "";
    document.getElementById("profile-interests").value = (profile.research_interests || []).join(", ");
    document.getElementById("profile-bio").value = profile.bio || "";
    document.getElementById("profile-public").checked = profile.is_public !== false;
    document.getElementById("profile-editor-error").textContent = "";
    accountDialog.close();
    document.getElementById("profile-editor-dialog").showModal();
    document.getElementById("profile-display-name").focus();
  }

  async function saveProfile(event) {
    event.preventDefault();
    if (!state.session || state.busy) return;
    var username = document.getElementById("profile-username").value.trim().toLowerCase();
    var displayName = document.getElementById("profile-display-name").value.trim();
    var orcid = document.getElementById("profile-orcid").value.trim();
    var errorElement = document.getElementById("profile-editor-error");
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(username)) {
      errorElement.textContent = "Choose a username with 3–32 letters, numbers, underscores or hyphens.";
      return;
    }
    if (!displayName) {
      errorElement.textContent = "Display name is required.";
      return;
    }
    if (orcid && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(orcid)) {
      errorElement.textContent = "Enter an ORCID in 0000-0000-0000-0000 format.";
      return;
    }
    try {
      setBusy(true);
      var website = document.getElementById("profile-website").value.trim();
      var avatar = document.getElementById("profile-avatar").value.trim();
      [website, avatar].forEach(function (value) {
        if (!value) return;
        var url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Website and photo URLs must use http or https.");
      });
      state.profile = await saveProfileData(state.session.user.id, {
        username: username,
        display_name: displayName,
        affiliation: document.getElementById("profile-affiliation").value.trim(),
        country: document.getElementById("profile-country").value.trim(),
        orcid: orcid || null,
        website: website || null,
        avatar_url: avatar || null,
        research_interests: document.getElementById("profile-interests").value.split(",")
          .map(function (item) { return item.trim(); }).filter(Boolean),
        bio: document.getElementById("profile-bio").value.trim(),
        is_public: document.getElementById("profile-public").checked
      });
      document.getElementById("profile-editor-dialog").close();
      document.getElementById("account-greeting").textContent = "Signed in as " + state.profile.display_name;
      if (state.route) openProfile(state.profile.username, false);
    } catch (error) {
      errorElement.textContent = error.message || "Profile could not be saved.";
    } finally {
      setBusy(false);
    }
  }

  function hideSiteForProfile() {
    if (state.route) return;
    state.route = true;
    Array.prototype.forEach.call(wrap.children, function (child) {
      if (child !== topBar && child !== profileView) {
        child.dataset.profileHidden = child.hidden ? "already-hidden" : "shown";
        child.hidden = true;
      }
    });
    profileView.hidden = false;
  }

  function leaveProfileRoute() {
    profileRouteVersion++;
    state.route = false;
    profileView.hidden = true;
    profileView.innerHTML = "";
    Array.prototype.forEach.call(wrap.children, function (child) {
      if (child.dataset.profileHidden) {
        child.hidden = child.dataset.profileHidden === "already-hidden";
        delete child.dataset.profileHidden;
      }
    });
  }

  async function openProfile(username, pushState) {
    var normalized = String(username || "").toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(normalized)) return;
    var routeVersion = ++profileRouteVersion;
    hideSiteForProfile();
    profileView.innerHTML = '<div class="account-muted" role="status">Loading profile…</div>';
    var path = profileHref(normalized);
    if (pushState) window.history.pushState({ privcProfile: true }, "", path);
    window.scrollTo(0, 0);
    try {
      var profile = await getProfileByUsername(normalized);
      if (routeVersion !== profileRouteVersion) return;
      if (!profile) {
        profileView.innerHTML = '<button type="button" data-profile-back>Back to Atlas</button>' +
          '<div class="profile-private">This profile is private or could not be found.</div>';
      } else {
        var interests = (profile.research_interests || []).map(function (interest) {
          return '<span class="profile-interest">' + escapeHtml(interest) + "</span>";
        }).join("");
        var website = "";
        try {
          if (profile.website) {
            var parsed = new URL(profile.website);
            if (parsed.protocol === "https:" || parsed.protocol === "http:") {
              website = '<a href="' + escapeHtml(parsed.href) + '" target="_blank" rel="noopener noreferrer">Website</a>';
            }
          }
        } catch (error) {
          website = "";
        }
        profileView.innerHTML = '<button type="button" data-profile-back>Back to Atlas</button>' +
          '<div class="profile-page-head" style="margin-top:16px">' + avatarMarkup(profile) +
          '<div><h2>' + escapeHtml(profile.display_name || profile.username) + '</h2>' +
          '<div class="account-muted">@' + escapeHtml(profile.username) + "</div>" +
          (profile.affiliation ? '<p>' + escapeHtml(profile.affiliation) + "</p>" : "") +
          (profile.country ? '<p class="account-muted">' + escapeHtml(profile.country) + "</p>" : "") +
          "</div></div>" +
          (profile.bio ? '<p class="profile-bio">' + escapeHtml(profile.bio) + "</p>" : "") +
          (interests ? '<h3>Research interests</h3><div class="profile-interests">' + interests + "</div>" : "") +
          (profile.orcid ? '<p><b>ORCID</b> ' + escapeHtml(profile.orcid) + "</p>" : "") +
          (website ? '<p>' + website + "</p>" : "") +
          (state.session && state.session.user.id === profile.id
            ? '<div class="profile-page-actions"><button type="button" data-profile-edit>Edit profile</button></div>'
            : "") +
          '<div class="profile-phase-note">Publications, follows and verified readership metrics will appear as the publishing and community phases are enabled.</div>';
      }
      profileView.querySelectorAll("[data-profile-back]").forEach(function (button) {
        button.addEventListener("click", function () {
          if (window.history.state && window.history.state.privcProfile) window.history.back();
          else {
            window.history.replaceState(null, "", routeBase());
            leaveProfileRoute();
          }
        });
      });
      var editButton = profileView.querySelector("[data-profile-edit]");
      if (editButton) editButton.addEventListener("click", editProfile);
    } catch (error) {
      if (routeVersion !== profileRouteVersion) return;
      profileView.innerHTML = '<button type="button" data-profile-back>Back to Atlas</button>' +
        '<div class="profile-private">Profile could not be loaded: ' + escapeHtml(error.message) + "</div>";
      profileView.querySelector("[data-profile-back]").addEventListener("click", function () {
        if (window.history.state && window.history.state.privcProfile) window.history.back();
        else {
          window.history.replaceState(null, "", routeBase());
          leaveProfileRoute();
        }
      });
    }
  }

  function handleProfileRoute() {
    var match = window.location.pathname.match(/\/u\/([^/]+)\/?$/);
    if (match) {
      var username;
      try { username = decodeURIComponent(match[1]); }
      catch (error) { return; }
      openProfile(username, false);
      return;
    }
    if (state.route) leaveProfileRoute();
  }

  document.addEventListener("DOMContentLoaded", function () {
    try {
      createInterface();
      if (window.PRIVC_AUTH && window.PRIVC_AUTH.initError) {
        setStatus(window.PRIVC_AUTH.initError, true);
      }
    } catch (error) {
      var status = document.getElementById("account-status");
      if (status) {
        status.textContent = error.message;
        status.classList.add("error");
      }
    }
  });

  window.PRIVC_PROFILES = {
    getProfileById: getProfileById,
    getProfileByUsername: getProfileByUsername,
    saveProfile: saveProfileData,
    openProfile: openProfile
  };
})();
