(function() {
  /* ── Constants ─────────────────────────────────────── */
  var TOKEN_KEY    = "rc_token";
  var THEME_KEY    = "rc_theme";
  var MODE_KEY     = "rc_mode";
  var CHAT_PREFIX  = "rc_chat_";
  var CHAT_INDEX   = "rc_chat_index";
  var MAX_STORED_CHATS = 50;

  /* ── State ─────────────────────────────────────────── */
  var token   = localStorage.getItem(TOKEN_KEY) || "";
  var mode    = localStorage.getItem(MODE_KEY) || "agent";
  var ws      = null;
  var running = false;
  var llmUiState = "disconnected"; // disconnected | connected | running | stalled
  var lastWsMessageAt = 0;
  var llmWatchdogTimer = null;
  var currentAssistantEl = null;
  var wsReconnectTimer = null;
  var wsReconnectDelay = 1000;
  var activeChatId = null;
  var chatList = [];
  var currentAssistantContent = "";
  var pendingUserMessage = null;
  var projectPathById = {};

  /* ── Haptic Feedback ────────────────────────────────── */
  function haptic(duration) {
    if (navigator.vibrate) navigator.vibrate(duration || 10);
  }

  /* ── Toast Notifications ────────────────────────────── */
  var toastContainer = document.getElementById("toast-container");
  function showToast(message, type, durationMs) {
    type = type || "info";
    durationMs = durationMs || 3000;
    var el = document.createElement("div");
    el.className = "toast toast-" + type;
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(function() {
      el.classList.add("removing");
      setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 250);
    }, durationMs);
  }

  /* ── Connection Banner ──────────────────────────────── */
  var connectionBanner = document.getElementById("connection-banner");
  var connectionBannerText = document.getElementById("connection-banner-text");
  function showConnectionBanner(text) {
    connectionBannerText.textContent = text;
    connectionBanner.classList.remove("hidden");
  }
  function hideConnectionBanner() {
    connectionBanner.classList.add("hidden");
  }

  /* ── Service Worker Registration ─────────────────── */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function() {});
  }

  /* ── Notification Permission ────────────────────── */
  var notificationsEnabled = false;

  function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      notificationsEnabled = true;
      return;
    }
    if (Notification.permission !== "denied") {
      Notification.requestPermission().then(function(perm) {
        notificationsEnabled = perm === "granted";
      });
    }
  }

  function sendNotification(title, body) {
    if (!notificationsEnabled || document.hasFocus()) return;
    try {
      new Notification(title, {
        body: body,
        icon: "/icon-192.svg",
        tag: "orbit-prompt",
      });
    } catch (e) { /* ignore */ }
  }

  /* ── Elements ──────────────────────────────────────── */
  var authGate       = document.getElementById("auth-gate");
  var authInput      = document.getElementById("auth-input");
  var authSubmit     = document.getElementById("auth-submit");
  var authError      = document.getElementById("auth-error");
  var sidebar        = document.getElementById("sidebar");
  var sidebarOverlay = document.getElementById("sidebar-overlay");
  var sidebarToggle  = document.getElementById("sidebar-toggle");
  var sidebarClose   = document.getElementById("sidebar-close");
  var newChatBtn     = document.getElementById("new-chat-btn");
  var sidebarChats   = document.getElementById("sidebar-chats");
  var sidebarChatsEmpty = document.getElementById("sidebar-chats-empty");
  var sidebarSettingsBtn = document.getElementById("sidebar-settings-btn");
  var sidebarSettings = document.getElementById("sidebar-settings");
  var statusDot      = document.getElementById("status-dot");
  var projectSel     = document.getElementById("project-select");
  var modelSel       = document.getElementById("model-select");
  var chatWrap       = document.getElementById("chat-wrap");
  var chat           = document.getElementById("chat");
  var welcome        = document.getElementById("welcome");
  var promptInput    = document.getElementById("prompt-input");
  var actionBtn      = document.getElementById("action-btn");
  var sendIcon       = document.getElementById("send-icon");
  var stopIcon       = document.getElementById("stop-icon");
  var devBtn         = document.getElementById("dev-btn");
  var devBadge       = document.getElementById("dev-badge");
  var tunnelPort     = document.getElementById("tunnel-port");
  var tunnelBtn      = document.getElementById("tunnel-btn");
  var tunnelBadge    = document.getElementById("tunnel-badge");
  var tunnelUrl      = document.getElementById("tunnel-url");
  var statusBtn      = document.getElementById("status-btn");
  var themeToggle    = document.getElementById("theme-toggle");
  var themeLabel     = document.getElementById("theme-label");
  var metaTheme      = document.getElementById("meta-theme");
  var llmStatusPill  = document.getElementById("llm-status-pill");

  function setLlmUiState(state, title) {
    llmUiState = state;
    if (llmStatusPill) {
      llmStatusPill.classList.remove("connected", "running", "stalled");
      llmStatusPill.textContent = state === "connected" ? "Connected"
        : state === "running" ? "Running"
        : state === "stalled" ? "Stalled"
        : "Disconnected";
      if (state === "connected") llmStatusPill.classList.add("connected");
      if (state === "running") llmStatusPill.classList.add("running");
      if (state === "stalled") llmStatusPill.classList.add("stalled");
      llmStatusPill.title = title || ("LLM status: " + llmStatusPill.textContent);
    }

    statusDot.classList.remove("stalled");
    if (state === "stalled") statusDot.classList.add("stalled");
  }

  /* ── Theme ─────────────────────────────────────────── */
  function applyTheme(pref) {
    var html = document.documentElement;
    var iconSun  = document.getElementById("theme-icon-sun");
    var iconMoon = document.getElementById("theme-icon-moon");
    var iconAuto = document.getElementById("theme-icon-auto");

    iconSun.classList.add("hidden");
    iconMoon.classList.add("hidden");
    iconAuto.classList.add("hidden");

    if (pref === "light") {
      html.setAttribute("data-theme", "light");
      metaTheme.content = "#f5f5f7";
      themeLabel.textContent = "Light";
      iconSun.classList.remove("hidden");
    } else if (pref === "dark") {
      html.setAttribute("data-theme", "dark");
      metaTheme.content = "#0b0b11";
      themeLabel.textContent = "Dark";
      iconMoon.classList.remove("hidden");
    } else {
      html.removeAttribute("data-theme");
      var isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      metaTheme.content = isDark ? "#0b0b11" : "#f5f5f7";
      themeLabel.textContent = "System";
      iconAuto.classList.remove("hidden");
    }
  }

  function cycleTheme() {
    var current = localStorage.getItem(THEME_KEY);
    var next;
    if (!current) next = "light";
    else if (current === "light") next = "dark";
    else next = null;

    if (next) localStorage.setItem(THEME_KEY, next);
    else localStorage.removeItem(THEME_KEY);

    applyTheme(next);
  }

  applyTheme(localStorage.getItem(THEME_KEY));
  themeToggle.addEventListener("click", cycleTheme);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function() {
    if (!localStorage.getItem(THEME_KEY)) {
      metaTheme.content = window.matchMedia("(prefers-color-scheme: dark)").matches ? "#0b0b11" : "#f5f5f7";
    }
  });

  /* ── Sidebar ───────────────────────────────────────── */
  function openSidebar() {
    sidebar.classList.add("open");
    sidebarOverlay.classList.add("active");
    loadChatList();
  }

  function closeSidebar() {
    sidebar.classList.remove("open");
    sidebarOverlay.classList.remove("active");
  }

  sidebarToggle.addEventListener("click", openSidebar);
  sidebarClose.addEventListener("click", closeSidebar);
  sidebarOverlay.addEventListener("click", closeSidebar);

  sidebarSettingsBtn.addEventListener("click", function() {
    var expanded = sidebarSettings.classList.contains("expanded");
    if (expanded) {
      sidebarSettings.classList.remove("expanded");
      sidebarSettings.classList.add("hidden");
      sidebarSettingsBtn.classList.remove("expanded");
    } else {
      sidebarSettings.classList.remove("hidden");
      sidebarSettings.classList.add("expanded");
      sidebarSettingsBtn.classList.add("expanded");
    }
  });

  /* ── Auth ───────────────────────────────────────────── */
  async function checkAuth() {
    try {
      var res = await api("/api/status");
      if (res.ok) { authGate.classList.add("hidden"); init(); return; }
      if (res.status === 401) { authGate.classList.remove("hidden"); return; }
    } catch (e) {
      authGate.classList.add("hidden");
      init();
    }
  }

  authSubmit.addEventListener("click", async function() {
    token = authInput.value.trim();
    localStorage.setItem(TOKEN_KEY, token);
    var res = await api("/api/status");
    if (res.ok) { authGate.classList.add("hidden"); authError.classList.add("hidden"); init(); }
    else { authError.classList.remove("hidden"); }
  });

  authInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") authSubmit.click();
  });

  /* ── API Helper ────────────────────────────────────── */
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (token) headers["Authorization"] = "Bearer " + token;
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  /* ── Init ───────────────────────────────────────────── */
  async function init() {
    await Promise.all([loadProjects(), loadModels(), loadStatus()]);
    connectWs();
    loadProjectTemplates();
  }

  async function loadProjects() {
    try {
      var res = await api("/api/projects");
      var data = await res.json();
      projectSel.innerHTML = '<option value="">\u2014 select project \u2014</option>';
      projectPathById = {};
      (data.projects || []).forEach(function(p) {
        var id = p.id;
        var path = p.path;
        var name = p.name || (path ? path.split("/").pop() : id);
        if (id && path) projectPathById[id] = path;
        var opt = document.createElement("option");
        opt.value = id;
        opt.textContent = name;
        projectSel.appendChild(opt);
      });
    } catch (e) { /* offline */ }
  }

  async function loadModels() {
    try {
      var res = await api("/api/models");
      var data = await res.json();
      modelSel.innerHTML = "";
      data.models.forEach(function(m) {
        var opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        modelSel.appendChild(opt);
      });
    } catch (e) { /* offline */ }
  }

  async function loadStatus() {
    try {
      var res = await api("/api/status");
      var s = await res.json();
      if (s.projectId) {
        projectSel.value = s.projectId;
      } else if (s.project) {
        // Backward compat: try to map projectPath -> projectId.
        try {
          if (!projectSel.options || projectSel.options.length <= 1) {
            await loadProjects();
          }
          Array.from(projectSel.options).some(function(opt) {
            var id = opt.value;
            if (id && projectPathById[id] === s.project) {
              projectSel.value = id;
              return true;
            }
            return false;
          });
        } catch (e) { /* ignore */ }
      }
      if (s.model) modelSel.value = s.model;
      if (s.activeChatId) {
        activeChatId = s.activeChatId;
        restoreChatMessages(s.activeChatId);
      }
      if (s.tunnel) {
        tunnelUrl.innerHTML = '<a href="' + s.tunnel.url + '" target="_blank">' + s.tunnel.url + '</a>';
        tunnelUrl.classList.remove("hidden");
        tunnelBtn.textContent = "Stop";
        tunnelBtn.classList.add("active");
        tunnelPort.value = s.tunnel.port;
        tunnelPort.disabled = true;
        tunnelBadge.classList.remove("hidden");
      }
      if (s.devServer) {
        devBtn.textContent = "Stop";
        devBtn.classList.add("active");
        devBadge.classList.remove("hidden");
      }

      // If a prompt is already running (page refresh / reconnect), keep Stop available.
      if (s.promptRunning) {
        running = true;
        setRunningUI(true);
        setLlmUiState("running", "Prompt running (restored from server status)");
      } else {
        running = false;
        setRunningUI(false);
        setLlmUiState(ws && ws.readyState === WebSocket.OPEN ? "connected" : "disconnected");
      }
    } catch (e) { /* offline */ }
  }

  /* ── Selectors ─────────────────────────────────────── */
  projectSel.addEventListener("change", async function() {
    if (!projectSel.value) return;
    await api("/api/project", { method: "POST", body: JSON.stringify({ projectId: projectSel.value }) });
    activeChatId = null;
    clearChatUI();
    showWelcome();
    loadChatList();
  });

  modelSel.addEventListener("change", async function() {
    if (!modelSel.value) return;
    await api("/api/model", { method: "POST", body: JSON.stringify({ name: modelSel.value }) });
  });

  /* ── Mode Buttons ──────────────────────────────────── */
  var modeButtons = document.querySelectorAll(".mode-btn");
  modeButtons.forEach(function(btn) {
    if (btn.dataset.mode === mode) {
      modeButtons.forEach(function(b) { b.classList.remove("active"); });
      btn.classList.add("active");
    }
    btn.addEventListener("click", function() {
      modeButtons.forEach(function(b) { b.classList.remove("active"); });
      btn.classList.add("active");
      mode = btn.dataset.mode;
      localStorage.setItem(MODE_KEY, mode);
    });
  });

  /* ── Textarea Auto-Resize ──────────────────────────── */
  promptInput.addEventListener("input", function() {
    promptInput.style.height = "auto";
    promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + "px";
  });

  promptInput.addEventListener("focus", function() {
    setTimeout(scrollToBottom, 300);
  });

  /* ── Scroll Helpers ────────────────────────────────── */
  function isNearBottom() {
    return chatWrap.scrollTop + chatWrap.clientHeight >= chatWrap.scrollHeight - 80;
  }

  function scrollToBottom() {
    chatWrap.scrollTop = chatWrap.scrollHeight;
  }

  /* ── Escape HTML ───────────────────────────────────── */
  function escapeHtml(str) {
    var d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  /* ── Lightweight Markdown Renderer ────────────────── */
  function renderMarkdown(text) {
    if (!text) return "";
    var html = escapeHtml(text);

    // Code blocks with language
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
      var header = lang
        ? '<div class="code-block-header"><span>' + lang + '</span><button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.closest(\'pre\').querySelector(\'code\').textContent)">Copy</button></div>'
        : '<div class="code-block-header"><span>code</span><button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.closest(\'pre\').querySelector(\'code\').textContent)">Copy</button></div>';
      return '<pre>' + header + '<code>' + code.replace(/^\n|\n$/g, '') + '</code></pre>';
    });

    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Blockquotes
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Paragraphs (double newline)
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';

    // Clean up empty paragraphs and ones wrapping block elements
    html = html.replace(/<p><\/p>/g, '');
    html = html.replace(/<p>(<h[1-3]>)/g, '$1');
    html = html.replace(/(<\/h[1-3]>)<\/p>/g, '$1');
    html = html.replace(/<p>(<pre>)/g, '$1');
    html = html.replace(/(<\/pre>)<\/p>/g, '$1');
    html = html.replace(/<p>(<ul>)/g, '$1');
    html = html.replace(/(<\/ul>)<\/p>/g, '$1');
    html = html.replace(/<p>(<blockquote>)/g, '$1');
    html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');

    return html;
  }

  /* ── Chat Message Helpers ──────────────────────────── */
  function removeWelcome() {
    if (welcome && welcome.parentNode) {
      welcome.parentNode.removeChild(welcome);
      welcome = null;
    }
  }

  function addUserMessage(text, skipAnimation) {
    removeWelcome();
    var msg = document.createElement("div");
    msg.className = "msg msg-user";
    if (skipAnimation) msg.style.animation = "none";
    msg.innerHTML = '<div class="msg-label">You</div><div class="msg-body">' + escapeHtml(text) + '</div>';
    chat.appendChild(msg);
    scrollToBottom();
  }

  function startAssistantMessage(meta) {
    removeWelcome();
    currentAssistantEl = document.createElement("div");
    currentAssistantEl.className = "msg msg-assistant";

    var label = document.createElement("div");
    label.className = "msg-label";
    var projText = meta.projectName
      ? meta.projectName
      : meta.projectPath
        ? meta.projectPath.split("/").pop()
        : meta.project
          ? meta.project.split("/").pop()
          : "";
    label.innerHTML = '<span class="msg-mode-pill">' + escapeHtml(meta.mode) + '</span> '
      + escapeHtml(projText) + ' \u00b7 ' + escapeHtml(meta.model);
    currentAssistantEl.appendChild(label);

    var stream = document.createElement("pre");
    stream.className = "msg-stream streaming";
    currentAssistantEl.appendChild(stream);

    chat.appendChild(currentAssistantEl);
    scrollToBottom();
  }

  function appendChunk(text) {
    if (!currentAssistantEl) return;
    var stream = currentAssistantEl.querySelector(".msg-stream");
    var shouldScroll = isNearBottom();
    stream.textContent += text;
    if (shouldScroll) scrollToBottom();
  }

  function endAssistantMessage(exitCode, timedOut) {
    if (!currentAssistantEl) return;
    var stream = currentAssistantEl.querySelector(".msg-stream");
    if (stream) {
      stream.classList.remove("streaming");
      var rawText = stream.textContent || "";
      if (rawText.length > 0) {
        var formatted = document.createElement("div");
        formatted.className = "msg-formatted";
        formatted.innerHTML = renderMarkdown(rawText);
        stream.replaceWith(formatted);
      }
    }

    var status = document.createElement("div");
    if (timedOut) {
      status.className = "msg-status timeout";
      status.textContent = "Timed out";
    } else if (exitCode === 0) {
      status.className = "msg-status success";
      status.textContent = "Completed";
    } else {
      status.className = "msg-status error";
      status.textContent = "Exit code " + exitCode;
    }
    currentAssistantEl.appendChild(status);
    currentAssistantEl = null;
  }

  function addSystemMessage(text, type, skipAnimation) {
    removeWelcome();
    var msg = document.createElement("div");
    msg.className = "msg msg-system " + (type || "info");
    if (skipAnimation) msg.style.animation = "none";
    msg.innerHTML = '<div class="msg-body">' + escapeHtml(text) + '</div>';
    chat.appendChild(msg);
    scrollToBottom();
  }

  /* ── Chat History (localStorage) ───────────────────── */
  function saveChatMessage(chatId, role, content, meta) {
    if (!chatId) return;
    var key = CHAT_PREFIX + chatId;
    var messages = [];
    try { messages = JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { /* ignore */ }
    messages.push({ role: role, content: content, timestamp: Date.now(), meta: meta || null });
    try { localStorage.setItem(key, JSON.stringify(messages)); } catch (e) { /* quota exceeded */ }
  }

  function loadChatMessages(chatId) {
    if (!chatId) return [];
    try { return JSON.parse(localStorage.getItem(CHAT_PREFIX + chatId) || "[]"); } catch (e) { return []; }
  }

  function deleteChatMessages(chatId) {
    localStorage.removeItem(CHAT_PREFIX + chatId);
  }

  function pruneChatStorage() {
    var index = [];
    try { index = JSON.parse(localStorage.getItem(CHAT_INDEX) || "[]"); } catch (e) { /* ignore */ }
    if (index.length > MAX_STORED_CHATS) {
      var toRemove = index.slice(MAX_STORED_CHATS);
      toRemove.forEach(function(id) { localStorage.removeItem(CHAT_PREFIX + id); });
      index = index.slice(0, MAX_STORED_CHATS);
      localStorage.setItem(CHAT_INDEX, JSON.stringify(index));
    }
  }

  function trackChatInIndex(chatId) {
    var index = [];
    try { index = JSON.parse(localStorage.getItem(CHAT_INDEX) || "[]"); } catch (e) { /* ignore */ }
    index = index.filter(function(id) { return id !== chatId; });
    index.unshift(chatId);
    localStorage.setItem(CHAT_INDEX, JSON.stringify(index));
    pruneChatStorage();
  }

  /* ── Chat List Management ────────────────────────── */
  async function loadChatList() {
    try {
      var projectId = projectSel.value || undefined;
      var url = "/api/chats" + (projectId ? "?projectId=" + encodeURIComponent(projectId) : "");
      var res = await api(url);
      var data = await res.json();
      chatList = data.chats || [];
      renderChatList();
    } catch (e) { /* offline */ }
  }

  function renderChatList() {
    while (sidebarChats.firstChild && sidebarChats.firstChild !== sidebarChatsEmpty) {
      sidebarChats.removeChild(sidebarChats.firstChild);
    }
    sidebarChats.innerHTML = "";

    if (chatList.length === 0) {
      sidebarChats.innerHTML = '<div class="sidebar-chats-empty">No chats yet</div>';
      return;
    }

    var groups = {};
    chatList.forEach(function(c) {
      var projId = c.projectId || "";
      var projPath = c.projectPath || projectPathById[projId] || "";
      var proj = projPath ? projPath.split("/").pop() : (projId ? projId : "Unknown");
      if (!groups[proj]) groups[proj] = [];
      groups[proj].push(c);
    });

    Object.keys(groups).forEach(function(proj) {
      var label = document.createElement("div");
      label.className = "sidebar-chat-group-label";
      label.textContent = proj;
      sidebarChats.appendChild(label);

      groups[proj].forEach(function(c) {
        var item = document.createElement("div");
        item.className = "sidebar-chat-item" + (c.id === activeChatId ? " active" : "");
        item.dataset.chatId = c.id;

        var info = document.createElement("div");
        info.className = "sidebar-chat-info";

        var title = document.createElement("div");
        title.className = "sidebar-chat-title";
        title.textContent = c.title || c.preview || "New chat";
        info.appendChild(title);

        var meta = document.createElement("div");
        meta.className = "sidebar-chat-meta";
        meta.textContent = formatTimeAgo(c.lastMessageAt) + (c.messageCount ? " \u00b7 " + c.messageCount + " msgs" : "");
        info.appendChild(meta);

        item.appendChild(info);

        var delBtn = document.createElement("button");
        delBtn.className = "sidebar-chat-delete";
        delBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        delBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          deleteChat(c.id);
        });
        item.appendChild(delBtn);

        item.addEventListener("click", function() {
          switchToChat(c.id);
          closeSidebar();
        });

        sidebarChats.appendChild(item);
      });
    });
  }

  function formatTimeAgo(ts) {
    if (!ts) return "";
    var diff = Date.now() - ts;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  async function deleteChat(chatId) {
    try {
      await api("/api/chats/" + chatId, { method: "DELETE" });
      deleteChatMessages(chatId);
      if (activeChatId === chatId) {
        activeChatId = null;
        clearChatUI();
        showWelcome();
      }
      loadChatList();
    } catch (e) { /* ignore */ }
  }

  function switchToChat(chatId) {
    activeChatId = chatId;
    api("/api/chats/" + chatId + "/select", { method: "POST" });
    clearChatUI();
    restoreChatMessages(chatId);
    renderChatList();
  }

  function clearChatUI() {
    chat.innerHTML = "";
    currentAssistantEl = null;
    currentAssistantContent = "";
  }

  function showWelcome() {
    chat.innerHTML = '<div class="welcome" id="welcome">'
      + '<div class="welcome-icon"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg></div>'
      + '<h2>Orbit</h2>'
      + '<p>Select a project and send a prompt to get started.</p>'
      + '</div>';
    welcome = document.getElementById("welcome");
  }

  function restoreChatMessages(chatId) {
    var messages = loadChatMessages(chatId);
    if (messages.length === 0) {
      showWelcome();
      return;
    }
    messages.forEach(function(m) {
      if (m.role === "user") {
        addUserMessage(m.content, true);
      } else if (m.role === "assistant") {
        renderRestoredAssistant(m.content, m.meta);
      } else if (m.role === "system") {
        addSystemMessage(m.content, m.meta && m.meta.type || "info", true);
      }
    });
    scrollToBottom();
  }

  function renderRestoredAssistant(content, meta) {
    removeWelcome();
    var msg = document.createElement("div");
    msg.className = "msg msg-assistant";
    msg.style.animation = "none";

    var label = document.createElement("div");
    label.className = "msg-label";
    var modeText = meta && meta.mode ? meta.mode : "agent";
    var projText = meta && meta.projectName
      ? meta.projectName
      : meta && meta.projectPath
        ? meta.projectPath.split("/").pop()
        : meta && meta.project
          ? meta.project.split("/").pop()
          : "";
    var modelText = meta && meta.model ? meta.model : "";
    label.innerHTML = '<span class="msg-mode-pill">' + escapeHtml(modeText) + '</span> '
      + escapeHtml(projText) + (modelText ? ' \u00b7 ' + escapeHtml(modelText) : '');
    msg.appendChild(label);

    var formatted = document.createElement("div");
    formatted.className = "msg-formatted";
    formatted.innerHTML = renderMarkdown(content);
    msg.appendChild(formatted);

    if (meta) {
      var status = document.createElement("div");
      if (meta.timedOut) {
        status.className = "msg-status timeout";
        status.textContent = "Timed out";
      } else if (meta.exitCode === 0) {
        status.className = "msg-status success";
        status.textContent = "Completed";
      } else if (meta.exitCode != null) {
        status.className = "msg-status error";
        status.textContent = "Exit code " + meta.exitCode;
      }
      msg.appendChild(status);
    }

    chat.appendChild(msg);
  }

  async function startNewChat() {
    if (!projectSel.value) {
      addSystemMessage("Select a project first.", "error");
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addSystemMessage("Not connected yet. Please wait for reconnect.", "error");
      return;
    }

    // Create the chat immediately (don’t wait for first prompt).
    pendingUserMessage = null;
    ws.send(JSON.stringify({ type: "new-chat" }));

    // Optimistic UI: clear current view while the server creates a chatId.
    activeChatId = null;
    clearChatUI();
    showWelcome();
    closeSidebar();
  }

  newChatBtn.addEventListener("click", startNewChat);

  function autoTitleChat(chatId) {
    var messages = loadChatMessages(chatId);
    if (messages.length === 0) return;
    var firstUser = messages.find(function(m) { return m.role === "user"; });
    if (!firstUser) return;
    var title = firstUser.content.split("\n")[0].slice(0, 60);
    api("/api/chats/" + chatId + "/title", {
      method: "POST",
      body: JSON.stringify({ title: title }),
    }).catch(function() {});
  }

  /* ── Send Prompt ───────────────────────────────────── */
  function sendWs(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      addSystemMessage("Not connected yet. Please wait for reconnect.", "error");
      return false;
    }
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      addSystemMessage("Failed to send message", "error");
      return false;
    }
  }

  function sendPrompt() {
    var msg = promptInput.value.trim();
    if (!msg || running || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!projectSel.value) {
      addSystemMessage("Select a project first.", "error");
      return;
    }

    var fullMsg = msg;
    if (attachedFiles.length > 0) {
      var fileContext = attachedFiles.map(function(f) { return "@" + f; }).join(" ");
      fullMsg = "Files for context: " + fileContext + "\n\n" + msg;
    }

    requestNotificationPermission();

    addUserMessage(msg);
    var payload = { type: "prompt", message: fullMsg, mode: mode };
    if (activeChatId) {
      payload.chatId = activeChatId;
      saveChatMessage(activeChatId, "user", msg);
    } else {
      pendingUserMessage = msg;
    }
    sendWs(payload);
    promptInput.value = "";
    promptInput.style.height = "auto";
    attachedFiles = [];
    renderAttachedFiles();
    closeFilePicker();
  }

  /* ── Project Templates ───────────────────────────────── */
  async function loadProjectTemplates() {
    try {
      var res = await api("/api/templates");
      var data = await res.json();
      if (data.templates && data.templates.length > 0) {
        data.templates.forEach(function(t) {
          var pill = document.createElement("button");
          pill.className = "quick-action-pill";
          pill.dataset.prompt = t.content;
          pill.textContent = t.name;
          quickActions.appendChild(pill);
        });
      }
    } catch (e) { /* offline */ }
  }

  /* ── Quick Actions ──────────────────────────────────── */
  var quickActions = document.getElementById("quick-actions");
  quickActions.addEventListener("click", function(e) {
    var pill = e.target.closest(".quick-action-pill");
    if (!pill) return;
    haptic(10);
    var prompt = pill.dataset.prompt;
    if (prompt) {
      promptInput.value = prompt;
      promptInput.style.height = "auto";
      promptInput.style.height = Math.min(promptInput.scrollHeight, 140) + "px";
      promptInput.focus();
    }
  });

  /* ── Action Button (Send / Cancel) ─────────────────── */
  actionBtn.addEventListener("click", function() {
    haptic(10);
    if (running) {
      api("/api/prompt/cancel", { method: "POST" });
    } else {
      sendPrompt();
    }
  });

  promptInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendPrompt(); }
  });

  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape" && running) {
      e.preventDefault();
      api("/api/prompt/cancel", { method: "POST" });
      haptic(20);
    }
  });

  /* ── WebSocket ─────────────────────────────────────── */
  function connectWs() {
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (llmWatchdogTimer) { clearInterval(llmWatchdogTimer); llmWatchdogTimer = null; }

    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var url = proto + "//" + location.host + "/ws" + (token ? "?token=" + encodeURIComponent(token) : "");
    ws = new WebSocket(url);

    ws.addEventListener("open", function() {
      statusDot.classList.add("connected");
      statusDot.title = "Connected";
      wsReconnectDelay = 1000;
      hideConnectionBanner();
      lastWsMessageAt = Date.now();
      setLlmUiState(running ? "running" : "connected", "WebSocket connected");
      // Re-sync running state after reconnect (in case we missed start/done while offline).
      loadStatus();
    });

    ws.addEventListener("close", function() {
      statusDot.classList.remove("connected", "running");
      statusDot.title = "Disconnected";
      var delaySec = Math.round(wsReconnectDelay / 1000);
      showConnectionBanner("Disconnected — reconnecting in " + delaySec + "s…");
      setLlmUiState("disconnected", "Disconnected from server");
      if (running) {
        // Keep Stop button visible/working even if WS drops mid-run.
        setRunningUI(true);
      }
      wsReconnectTimer = setTimeout(connectWs, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30000);
    });

    ws.addEventListener("message", function(e) {
      var data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      lastWsMessageAt = Date.now();

      switch (data.type) {
        case "chat-created":
          activeChatId = data.chatId;
          trackChatInIndex(data.chatId);
          if (pendingUserMessage) {
            saveChatMessage(data.chatId, "user", pendingUserMessage);
            pendingUserMessage = null;
          }
          break;
        case "start":
          running = true;
          setRunningUI(true);
          setLlmUiState("running", "Prompt running");
          if (data.chatId && !activeChatId) activeChatId = data.chatId;
          currentAssistantContent = "";
          startAssistantMessage({
            mode: data.mode,
            project: data.project,
            projectId: data.projectId || projectSel.value,
            projectPath: data.project || projectPathById[projectSel.value] || "",
            projectName: data.projectName || (projectSel.options[projectSel.selectedIndex] && projectSel.options[projectSel.selectedIndex].textContent) || "",
            model: data.model,
          });
          break;
        case "chunk":
          currentAssistantContent += (data.data || "");
          appendChunk(data.data);
          if (llmUiState === "stalled") {
            hideConnectionBanner();
            setLlmUiState("running", "Output resumed");
          }
          break;
        case "done":
          running = false;
          setRunningUI(false);
          hideConnectionBanner();
          setLlmUiState("connected", "Idle");
          closeAgentApproval();
          endAssistantMessage(data.exitCode, data.timedOut);
          if (activeChatId) {
            saveChatMessage(activeChatId, "assistant", currentAssistantContent, {
              mode: mode,
              model: modelSel.value,
              projectId: projectSel.value,
              projectPath: projectPathById[projectSel.value] || "",
              projectName: (projectSel.options[projectSel.selectedIndex] && projectSel.options[projectSel.selectedIndex].textContent) || "",
              exitCode: data.exitCode,
              timedOut: data.timedOut,
            });
            trackChatInIndex(activeChatId);
            autoTitleChat(activeChatId);
          }
          currentAssistantContent = "";
          if (data.timedOut) {
            sendNotification("Orbit", "Prompt timed out");
          } else if (data.exitCode === 0) {
            sendNotification("Orbit", "Prompt completed successfully");
          } else {
            sendNotification("Orbit", "Prompt finished with exit code " + data.exitCode);
          }
          break;
        case "llm-status":
          if (data.status === "stalled") {
            var idleSec = Math.max(0, Math.round((data.idleMs || 0) / 1000));
            setLlmUiState("stalled", (data.message || "No output from LLM") + (idleSec ? (" (idle " + idleSec + "s)") : ""));
            showConnectionBanner("LLM stalled — no output for " + idleSec + "s. You can wait or press Stop.");
          } else if (data.status === "running") {
            hideConnectionBanner();
            setLlmUiState("running", "Output resumed");
          } else if (data.status === "waiting-for-input") {
            hideConnectionBanner();
            setLlmUiState("running", "Waiting for your approval");
          }
          break;
        case "error":
          running = false;
          setRunningUI(false);
          closeAgentApproval();
          setLlmUiState(ws && ws.readyState === WebSocket.OPEN ? "connected" : "disconnected", "Error: " + (data.message || "unknown"));
          if (currentAssistantEl) {
            var stream = currentAssistantEl.querySelector(".msg-stream");
            if (stream) stream.classList.remove("streaming");
            currentAssistantEl = null;
          }
          addSystemMessage(data.message, "error");
          break;
        case "permission-request":
          hideConnectionBanner();
          setLlmUiState("running", "Waiting for your approval");
          showPermissionRequest({
            requestId: data.requestId,
            title: data.title,
            detail: data.detail,
            raw: data.raw,
            options: data.options,
          });
          break;
        case "ask-question":
          hideConnectionBanner();
          setLlmUiState("running", "Waiting for your answer");
          showAskQuestion({
            requestId: data.requestId,
            title: data.title,
            questions: data.questions,
          });
          break;
        case "plan-request":
          hideConnectionBanner();
          setLlmUiState("running", "Waiting for plan review");
          showPlanRequest({
            requestId: data.requestId,
            name: data.name,
            overview: data.overview,
            planMarkdown: data.planMarkdown,
            todos: data.todos,
          });
          break;
      }
    });

    // Local watchdog: if a prompt is running and *nothing* has been received in a while,
    // mark as stalled even if the server didn't emit a stall warning (e.g. proxy issues).
    // Skip when the agent approval overlay is visible (user input expected, not a stall).
    llmWatchdogTimer = setInterval(function() {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!running) return;
      if (!lastWsMessageAt) return;
      if (agentApprovalState) return;
      var idleMs = Date.now() - lastWsMessageAt;
      if (idleMs >= 60000 && llmUiState !== "stalled") {
        setLlmUiState("stalled", "No messages received from server for " + Math.round(idleMs / 1000) + "s");
        showConnectionBanner("LLM stalled — no messages for " + Math.round(idleMs / 1000) + "s. You can wait or press Stop.");
      }
    }, 5000);
  }

  /* ── Running UI State ──────────────────────────────── */
  function setRunningUI(isRunning) {
    if (isRunning) {
      actionBtn.classList.add("stopping");
      sendIcon.classList.add("hidden");
      stopIcon.classList.remove("hidden");
      actionBtn.title = "Stop";
      actionBtn.setAttribute("aria-label", "Stop");
    } else {
      actionBtn.classList.remove("stopping");
      sendIcon.classList.remove("hidden");
      stopIcon.classList.add("hidden");
      actionBtn.title = "Send";
      actionBtn.setAttribute("aria-label", "Send");
    }
    statusDot.classList.toggle("running", isRunning);
    statusDot.title = isRunning ? "Running" : "Connected";
    if (!isRunning && llmUiState !== "disconnected") setLlmUiState("connected", "Idle");
  }

  /* ── Dev Server ────────────────────────────────────── */
  devBtn.addEventListener("click", async function() {
    if (devBtn.classList.contains("active")) {
      await api("/api/dev/stop", { method: "POST" });
      devBtn.textContent = "Start";
      devBtn.classList.remove("active");
      devBadge.classList.add("hidden");
      showToast("Dev server stopped", "info");
    } else {
      if (!projectSel.value) { addSystemMessage("Select a project first.", "error"); return; }
      devBtn.textContent = "Starting\u2026";
      var res = await api("/api/dev/start", { method: "POST", body: JSON.stringify({}) });
      var data = await res.json();
      devBtn.textContent = "Stop";
      devBtn.classList.add("active");
      devBadge.classList.remove("hidden");
      showToast("Dev server started" + (data.port ? " on port " + data.port : ""), "success");
    }
  });

  /* ── Tunnel ────────────────────────────────────────── */
  tunnelBtn.addEventListener("click", async function() {
    if (tunnelBtn.classList.contains("active")) {
      await api("/api/tunnel/stop", { method: "POST" });
      tunnelBtn.textContent = "Start";
      tunnelBtn.classList.remove("active");
      tunnelUrl.classList.add("hidden");
      tunnelPort.disabled = false;
      tunnelBadge.classList.add("hidden");
      showToast("Tunnel stopped", "info");
    } else {
      tunnelBtn.textContent = "Starting\u2026";
      var body = {};
      var portVal = parseInt(tunnelPort.value, 10);
      if (portVal > 0 && portVal <= 65535) body.port = portVal;
      var res = await api("/api/tunnel/start", { method: "POST", body: JSON.stringify(body) });
      var data = await res.json();
      if (data.url) {
        tunnelBtn.textContent = "Stop";
        tunnelBtn.classList.add("active");
        tunnelPort.disabled = true;
        tunnelUrl.innerHTML = '<a href="' + data.url + '" target="_blank">' + data.url + '</a>';
        tunnelUrl.classList.remove("hidden");
        tunnelBadge.classList.remove("hidden");
        showToast("Tunnel active on port " + data.port, "success");
      } else {
        tunnelBtn.textContent = "Start";
        addSystemMessage("Tunnel error: " + (data.error || "unknown"), "error");
      }
    }
  });

  /* ── Status Button ─────────────────────────────────── */
  statusBtn.addEventListener("click", async function() {
    var res = await api("/api/status");
    var s = await res.json();
    var lines = [
      "Project:  " + (s.project ? s.project.split("/").pop() : "(none)"),
      "Model:    " + (s.model || "(none)"),
      "Running:  " + (s.promptRunning ? "yes" : "no"),
      "Dev:      " + (s.devServer ? s.devServer.command + " (port " + s.devServer.port + ")" : "off"),
      "Tunnel:   " + (s.tunnel ? s.tunnel.url : "off"),
    ];
    addSystemMessage(lines.join("\n"), "info");
    closeSidebar();
  });

  /* ── File Picker ───────────────────────────────────── */
  var filePickerPanel = document.getElementById("file-picker-panel");
  var filePickerBody  = document.getElementById("file-picker-body");
  var filePickerPath  = document.getElementById("file-picker-path");
  var filePickerBack  = document.getElementById("file-picker-back");
  var filePickerClose = document.getElementById("file-picker-close");
  var fileAttachBtn   = document.getElementById("file-attach-btn");
  var attachedFilesEl = document.getElementById("attached-files");
  var attachedFiles   = [];
  var filePickerDir   = [];

  fileAttachBtn.addEventListener("click", function() {
    filePickerDir = [];
    openFilePicker("");
  });

  filePickerClose.addEventListener("click", closeFilePicker);

  filePickerBack.addEventListener("click", function() {
    if (filePickerDir.length > 0) {
      filePickerDir.pop();
      openFilePicker(filePickerDir.join("/"));
    } else {
      closeFilePicker();
    }
  });

  function openFilePicker(path) {
    filePickerPanel.classList.remove("hidden");
    setTimeout(function() { filePickerPanel.classList.add("open"); }, 10);
    filePickerPath.textContent = "/" + (path || "");
    loadFileEntries(path);
  }

  function closeFilePicker() {
    filePickerPanel.classList.remove("open");
    setTimeout(function() { filePickerPanel.classList.add("hidden"); }, 280);
  }

  async function loadFileEntries(path) {
    filePickerBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Loading…</div></div>';
    try {
      var url = "/api/files" + (path ? "?path=" + encodeURIComponent(path) : "");
      var res = await api(url);
      var data = await res.json();
      if (!res.ok) {
        filePickerBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">' + escapeHtml(data.error || "Error") + '</div></div>';
        return;
      }

      if (!data.entries || data.entries.length === 0) {
        filePickerBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Empty directory</div></div>';
        return;
      }

      var html = "";
      data.entries.forEach(function(entry) {
        var isAttached = attachedFiles.indexOf(entry.path) >= 0;
        html += '<div class="file-entry" data-path="' + escapeHtml(entry.path) + '" data-type="' + entry.type + '">'
          + '<span class="file-entry-icon ' + entry.type + '">' + (entry.type === "dir" ? "\ud83d\udcc1" : "\ud83d\udcc4") + '</span>'
          + '<span class="file-entry-name ' + entry.type + '">' + escapeHtml(entry.name) + '</span>';
        if (entry.type === "file") {
          html += '<button class="file-entry-select' + (isAttached ? " selected" : "") + '" data-select-path="' + escapeHtml(entry.path) + '">'
            + (isAttached ? "Added" : "Add") + '</button>';
        }
        html += '</div>';
      });

      filePickerBody.innerHTML = html;

      filePickerBody.querySelectorAll(".file-entry").forEach(function(row) {
        row.addEventListener("click", function(e) {
          if (e.target.closest(".file-entry-select")) return;
          var type = row.dataset.type;
          if (type === "dir") {
            filePickerDir = row.dataset.path.split("/");
            openFilePicker(row.dataset.path);
          }
        });
      });

      filePickerBody.querySelectorAll(".file-entry-select").forEach(function(btn) {
        btn.addEventListener("click", function(e) {
          e.stopPropagation();
          var path = btn.dataset.selectPath;
          var idx = attachedFiles.indexOf(path);
          if (idx >= 0) {
            attachedFiles.splice(idx, 1);
            btn.textContent = "Add";
            btn.classList.remove("selected");
          } else {
            attachedFiles.push(path);
            btn.textContent = "Added";
            btn.classList.add("selected");
          }
          renderAttachedFiles();
        });
      });
    } catch (e) {
      filePickerBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Failed to load files</div></div>';
    }
  }

  function renderAttachedFiles() {
    if (attachedFiles.length === 0) {
      attachedFilesEl.classList.add("hidden");
      attachedFilesEl.innerHTML = "";
      return;
    }

    attachedFilesEl.classList.remove("hidden");
    var html = "";
    attachedFiles.forEach(function(f) {
      var name = f.split("/").pop();
      html += '<span class="attached-file-chip">'
        + escapeHtml(name)
        + '<button class="attached-file-remove" data-remove-file="' + escapeHtml(f) + '">\u00d7</button>'
        + '</span>';
    });
    attachedFilesEl.innerHTML = html;

    attachedFilesEl.querySelectorAll(".attached-file-remove").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var path = btn.dataset.removeFile;
        attachedFiles = attachedFiles.filter(function(f) { return f !== path; });
        renderAttachedFiles();
      });
    });
  }

  /* ── Git Panel ─────────────────────────────────────── */
  var gitPanel       = document.getElementById("git-panel");
  var gitOpenBtn     = document.getElementById("git-open-btn");
  var gitBackBtn     = document.getElementById("git-back-btn");
  var gitRefreshBtn  = document.getElementById("git-refresh-btn");
  var gitBranch      = document.getElementById("git-branch");
  var gitAheadBehind = document.getElementById("git-ahead-behind");
  var gitBody        = document.getElementById("git-body");
  var gitBulkActions = document.getElementById("git-bulk-actions");
  var gitStageAll    = document.getElementById("git-stage-all");
  var gitUnstageAll  = document.getElementById("git-unstage-all");
  var gitCommitArea  = document.getElementById("git-commit-area");
  var gitCommitMsg   = document.getElementById("git-commit-msg");
  var gitCommitBtn   = document.getElementById("git-commit-btn");
  var gitDiffView    = document.getElementById("git-diff-view");
  var gitDiffBack    = document.getElementById("git-diff-back");
  var gitDiffFilename = document.getElementById("git-diff-filename");
  var gitDiffContent = document.getElementById("git-diff-content");
  var gitDiffFooter  = document.getElementById("git-diff-footer");
  var gitDiffAction  = document.getElementById("git-diff-action");
  var gitBranchActionsEl = document.getElementById("git-branch-actions");
  var gitNewBranchName = document.getElementById("git-new-branch-name");
  var gitCreateBranchBtn = document.getElementById("git-create-branch-btn");
  var gitStashRow    = document.getElementById("git-stash-row");
  var gitStashBtn    = document.getElementById("git-stash-btn");
  var gitStashPopBtn = document.getElementById("git-stash-pop-btn");
  var gitDiscardAllBtn = document.getElementById("git-discard-all");
  var gitPushRow     = document.getElementById("git-push-row");
  var gitPushBtn     = document.getElementById("git-push-btn");
  var gitFetchBtn    = document.getElementById("git-fetch-btn");
  var gitRemoteLabel = document.getElementById("git-remote-label");
  var gitConfirmOverlay = document.getElementById("git-confirm-overlay");
  var gitConfirmTitle = document.getElementById("git-confirm-title");
  var gitConfirmDesc = document.getElementById("git-confirm-desc");
  var gitConfirmCancel = document.getElementById("git-confirm-cancel");
  var gitConfirmOk   = document.getElementById("git-confirm-ok");
  var agentApprovalOverlay = document.getElementById("agent-approval-overlay");
  var agentApprovalTitle = document.getElementById("agent-approval-title");
  var agentApprovalDesc = document.getElementById("agent-approval-desc");
  var agentApprovalBody = document.getElementById("agent-approval-body");
  var agentApprovalBtns = document.getElementById("agent-approval-btns");
  var gitTabs        = document.querySelectorAll(".git-tab");
  var gitActiveTab   = "changes";
  var cachedGitStatus = null;
  var confirmCallback = null;
  var tabLoadVersion = 0;
  var agentApprovalState = null; // { type, requestId, payload }

  function closeAgentApproval() {
    agentApprovalState = null;
    agentApprovalOverlay.classList.add("hidden");
    agentApprovalTitle.textContent = "";
    agentApprovalDesc.textContent = "";
    agentApprovalBody.innerHTML = "";
    agentApprovalBtns.innerHTML = "";
  }

  function showAgentApprovalBase(title, desc) {
    agentApprovalTitle.textContent = title || "Agent needs input";
    agentApprovalDesc.textContent = desc || "";
    agentApprovalOverlay.classList.remove("hidden");
  }

  function showPermissionRequest(req) {
    agentApprovalState = { type: "permission", requestId: req.requestId, payload: req };
    showAgentApprovalBase(req.title || "Permission required", req.detail || "Approve or deny this action.");
    var detailText = req.detail || "";
    if (req.raw) {
      try {
        detailText = (detailText ? detailText + "\n\n" : "") + JSON.stringify(req.raw, null, 2);
      } catch (e) { /* ignore */ }
    }
    agentApprovalBody.innerHTML = '<pre>' + escapeHtml(detailText) + "</pre>";

    agentApprovalBtns.innerHTML = "";
    var deny = document.createElement("button");
    deny.type = "button";
    deny.className = "agent-approval-btn-danger";
    deny.textContent = "Deny";
    deny.addEventListener("click", function() {
      haptic(10);
      sendWs({ type: "permission-response", requestId: req.requestId, decision: "reject-once" });
      closeAgentApproval();
    });

    var allowOnce = document.createElement("button");
    allowOnce.type = "button";
    allowOnce.className = "agent-approval-btn-allow";
    allowOnce.textContent = "Allow once";
    allowOnce.addEventListener("click", function() {
      haptic(10);
      sendWs({ type: "permission-response", requestId: req.requestId, decision: "allow-once" });
      closeAgentApproval();
    });

    var allowAlways = document.createElement("button");
    allowAlways.type = "button";
    allowAlways.className = "agent-approval-btn-secondary";
    allowAlways.textContent = "Always allow";
    allowAlways.addEventListener("click", function() {
      haptic(10);
      sendWs({ type: "permission-response", requestId: req.requestId, decision: "allow-always" });
      closeAgentApproval();
    });

    // order: deny, allow once, always allow (matches risk)
    agentApprovalBtns.appendChild(deny);
    agentApprovalBtns.appendChild(allowOnce);
    agentApprovalBtns.appendChild(allowAlways);
  }

  function showAskQuestion(req) {
    agentApprovalState = { type: "ask", requestId: req.requestId, payload: req };
    showAgentApprovalBase(req.title || "Question", "Select an option to continue.");

    var body = document.createElement("div");
    (req.questions || []).forEach(function(q) {
      var qEl = document.createElement("div");
      qEl.className = "agent-approval-q";
      var title = document.createElement("div");
      title.className = "agent-approval-q-title";
      title.textContent = q.prompt || "";
      qEl.appendChild(title);

      var opts = document.createElement("div");
      opts.className = "agent-approval-options";
      var inputType = q.allowMultiple ? "checkbox" : "radio";
      var name = "aq_" + req.requestId + "_" + q.id;
      (q.options || []).forEach(function(opt) {
        var label = document.createElement("label");
        label.className = "agent-approval-opt";
        var input = document.createElement("input");
        input.type = inputType;
        input.name = name;
        input.value = opt.id;
        var span = document.createElement("span");
        span.textContent = opt.label;
        label.appendChild(input);
        label.appendChild(span);
        opts.appendChild(label);
      });
      qEl.appendChild(opts);
      body.appendChild(qEl);
    });

    agentApprovalBody.innerHTML = "";
    agentApprovalBody.appendChild(body);

    agentApprovalBtns.innerHTML = "";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "agent-approval-btn-secondary";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", function() {
      haptic(10);
      sendWs({ type: "ask-question-response", requestId: req.requestId, outcome: { outcome: "cancelled" } });
      closeAgentApproval();
    });

    var submit = document.createElement("button");
    submit.type = "button";
    submit.className = "agent-approval-btn-allow";
    submit.textContent = "Submit";
    submit.addEventListener("click", function() {
      haptic(10);
      var answers = [];
      (req.questions || []).forEach(function(q) {
        var name = "aq_" + req.requestId + "_" + q.id;
        var selected = [];
        agentApprovalBody.querySelectorAll('input[name="' + CSS.escape(name) + '"]').forEach(function(inp) {
          if (inp.checked) selected.push(inp.value);
        });
        answers.push({ questionId: q.id, selectedOptionIds: selected });
      });
      sendWs({
        type: "ask-question-response",
        requestId: req.requestId,
        outcome: { outcome: "answered", answers: answers },
      });
      closeAgentApproval();
    });

    agentApprovalBtns.appendChild(cancel);
    agentApprovalBtns.appendChild(submit);
  }

  function showPlanRequest(req) {
    agentApprovalState = { type: "plan", requestId: req.requestId, payload: req };
    showAgentApprovalBase(req.name || "Plan approval", req.overview || "Review the plan and accept or reject.");
    agentApprovalBody.innerHTML = '<pre>' + escapeHtml(req.planMarkdown || "") + "</pre>";

    agentApprovalBtns.innerHTML = "";
    var reject = document.createElement("button");
    reject.type = "button";
    reject.className = "agent-approval-btn-danger";
    reject.textContent = "Reject";
    reject.addEventListener("click", function() {
      haptic(10);
      sendWs({ type: "plan-response", requestId: req.requestId, outcome: { outcome: "rejected" } });
      closeAgentApproval();
    });

    var accept = document.createElement("button");
    accept.type = "button";
    accept.className = "agent-approval-btn-allow";
    accept.textContent = "Accept";
    accept.addEventListener("click", function() {
      haptic(10);
      sendWs({ type: "plan-response", requestId: req.requestId, outcome: { outcome: "accepted" } });
      closeAgentApproval();
    });

    agentApprovalBtns.appendChild(reject);
    agentApprovalBtns.appendChild(accept);
  }

  // Intentionally do NOT close this modal on outside click.

  function openGitPanel() {
    gitPanel.classList.add("open");
    showTabContent(gitActiveTab);
  }

  function closeGitPanel() {
    gitPanel.classList.remove("open");
  }

  gitOpenBtn.addEventListener("click", openGitPanel);
  gitBackBtn.addEventListener("click", closeGitPanel);

  function showTabContent(tabName) {
    tabLoadVersion++;
    var version = tabLoadVersion;

    gitBulkActions.classList.add("hidden");
    gitCommitArea.classList.add("hidden");
    gitBranchActionsEl.classList.add("hidden");
    gitStashRow.classList.add("hidden");

    if (tabName === "changes") {
      loadGitStatus(version);
    } else if (tabName === "branches") {
      gitBranchActionsEl.classList.remove("hidden");
      loadGitBranches(version);
    } else {
      loadGitLog(version);
    }
  }

  gitTabs.forEach(function(tab) {
    tab.addEventListener("click", function() {
      gitTabs.forEach(function(t) { t.classList.remove("active"); });
      tab.classList.add("active");
      gitActiveTab = tab.dataset.gitTab;
      showTabContent(gitActiveTab);
    });
  });

  gitRefreshBtn.addEventListener("click", function() {
    showTabContent(gitActiveTab);
  });

  /* ── Git Commit Input ───────────────────────────────── */
  gitCommitMsg.addEventListener("input", function() {
    gitCommitMsg.style.height = "auto";
    gitCommitMsg.style.height = Math.min(gitCommitMsg.scrollHeight, 100) + "px";
    updateCommitBtn();
  });

  function updateCommitBtn() {
    var hasMsg = gitCommitMsg.value.trim().length > 0;
    var stagedCount = cachedGitStatus ? cachedGitStatus.staged.length : 0;
    gitCommitBtn.disabled = !hasMsg || stagedCount === 0;
    gitCommitBtn.textContent = stagedCount > 0
      ? "Commit (" + stagedCount + " staged)"
      : "Commit";
  }

  /* ── Load Git Status ─────────────────────────────────── */
  async function loadGitStatus(version) {
    gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Loading…</div></div>';
    try {
      var res = await api("/api/git/status");
      if (version !== tabLoadVersion) return;
      if (!res.ok) {
        var err = await res.json();
        gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">' + escapeHtml(err.error || "Error") + '</div></div>';
        gitBulkActions.classList.add("hidden");
        gitCommitArea.classList.add("hidden");
        return;
      }
      var data = await res.json();
      cachedGitStatus = data;

      gitBranch.textContent = data.branch || "detached";
      var meta = [];
      if (data.ahead > 0) meta.push("↑" + data.ahead);
      if (data.behind > 0) meta.push("↓" + data.behind);
      gitAheadBehind.textContent = meta.join(" ");

      updatePushRow(data);

      var totalChanges = data.staged.length + data.unstaged.length + data.untracked.length;

      if (totalChanges === 0) {
        gitBody.innerHTML = '<div class="git-empty">'
          + '<div class="git-empty-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg></div>'
          + '<div class="git-empty-text">Working tree clean</div></div>';
        gitBulkActions.classList.add("hidden");
        gitCommitArea.classList.remove("hidden");
        gitStashRow.classList.remove("hidden");
        updateCommitBtn();
        refreshStashBtn();
        return;
      }

      var html = "";

      if (data.staged.length > 0) {
        html += renderFileSection("Staged", data.staged, true, "staged");
      }
      if (data.unstaged.length > 0) {
        html += renderFileSection("Modified", data.unstaged, false, "unstaged");
      }
      if (data.untracked.length > 0) {
        html += renderFileSection("Untracked", data.untracked, false, "untracked");
      }

      gitBody.innerHTML = html;
      gitBulkActions.classList.remove("hidden");
      gitCommitArea.classList.remove("hidden");
      gitStashRow.classList.remove("hidden");
      gitStageAll.disabled = (data.unstaged.length + data.untracked.length) === 0;
      gitUnstageAll.disabled = data.staged.length === 0;
      gitDiscardAllBtn.disabled = data.unstaged.length === 0;
      updateCommitBtn();
      refreshStashBtn();

      bindFileRowEvents();
    } catch (e) {
      gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Failed to load status</div></div>';
    }
  }

  function renderFileSection(label, files, isStaged, sectionType) {
    var html = '<div class="git-section-header">'
      + '<span class="git-section-label">' + escapeHtml(label) + '</span>'
      + '<span class="git-section-count">' + files.length + '</span></div>';

    var isUntracked = sectionType === "untracked";
    files.forEach(function(f) {
      var statusCls = "st-" + (f.status === "?" ? "q" : f.status);
      var actionCls = isStaged ? "unstage" : "stage";
      var actionChar = isStaged ? "−" : "+";
      html += '<div class="git-file-row" data-path="' + escapeHtml(f.path) + '" data-staged="' + (isStaged ? "1" : "0") + '" data-untracked="' + (isUntracked ? "1" : "0") + '">'
        + '<span class="git-file-status ' + statusCls + '">' + escapeHtml(f.status) + '</span>'
        + '<span class="git-file-path"><span>' + escapeHtml(f.path) + '</span></span>';
      if (sectionType === "unstaged") {
        html += '<button class="git-file-discard" data-discard-path="' + escapeHtml(f.path) + '" title="Discard changes">'
          + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
          + '</button>';
      }
      html += '<button class="git-file-action ' + actionCls + '" data-action="' + actionCls + '" data-path="' + escapeHtml(f.path) + '">' + actionChar + '</button>'
        + '</div>';
    });

    return html;
  }

  function bindFileRowEvents() {
    gitBody.querySelectorAll(".git-file-action").forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var path = btn.dataset.path;
        var action = btn.dataset.action;
        if (action === "stage") {
          stageFiles([path]);
        } else {
          unstageFiles([path]);
        }
      });
    });

    gitBody.querySelectorAll(".git-file-discard").forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var path = btn.dataset.discardPath;
        showConfirm(
          "Discard Changes",
          'Discard all changes to <code>' + escapeHtml(path) + '</code>?<br><span class="warn">This cannot be undone.</span>',
          "Discard",
          true,
          function() { discardFiles([path]); }
        );
      });
    });

    gitBody.querySelectorAll(".git-file-row").forEach(function(row) {
      row.addEventListener("click", function() {
        var path = row.dataset.path;
        var staged = row.dataset.staged === "1";
        var untracked = row.dataset.untracked === "1";
        openDiffView(path, staged, untracked);
      });
    });
  }

  /* ── Stage / Unstage ─────────────────────────────────── */
  async function stageFiles(files) {
    try {
      await api("/api/git/stage", { method: "POST", body: JSON.stringify({ files: files }) });
      await loadGitStatus();
    } catch (e) { /* ignore */ }
  }

  async function unstageFiles(files) {
    try {
      await api("/api/git/unstage", { method: "POST", body: JSON.stringify({ files: files }) });
      await loadGitStatus();
    } catch (e) { /* ignore */ }
  }

  gitStageAll.addEventListener("click", function() {
    if (!cachedGitStatus) return;
    var files = cachedGitStatus.unstaged.map(function(f) { return f.path; })
      .concat(cachedGitStatus.untracked.map(function(f) { return f.path; }));
    if (files.length > 0) stageFiles(files);
  });

  gitUnstageAll.addEventListener("click", function() {
    if (!cachedGitStatus) return;
    var files = cachedGitStatus.staged.map(function(f) { return f.path; });
    if (files.length > 0) unstageFiles(files);
  });

  /* ── Discard ─────────────────────────────────────────── */
  async function getApprovalToken(action, summary) {
    try {
      var reqRes = await api("/api/approvals/request", {
        method: "POST",
        body: JSON.stringify({ action: action, summary: summary }),
      });
      var reqData = await reqRes.json();
      if (!reqRes.ok) throw new Error(reqData.error || "request_failed");

      var resRes = await api("/api/approvals/resolve", {
        method: "POST",
        body: JSON.stringify({ approvalId: reqData.approvalId, decision: "approve" }),
      });
      var resData = await resRes.json();
      if (!resRes.ok || !resData.approved || !resData.approvalToken) throw new Error(resData.error || "resolve_failed");

      return resData.approvalToken;
    } catch (e) {
      addSystemMessage("Approval failed", "error");
      return null;
    }
  }

  async function discardFiles(files) {
    try {
      var token = await getApprovalToken("git.discard", "Discard changes to " + files.length + " file(s)");
      if (!token) return;
      await api("/api/git/discard", {
        method: "POST",
        headers: { "X-Approval-Token": token },
        body: JSON.stringify({ files: files }),
      });
      await loadGitStatus();
    } catch (e) { /* ignore */ }
  }

  gitDiscardAllBtn.addEventListener("click", function() {
    if (!cachedGitStatus || cachedGitStatus.unstaged.length === 0) return;
    showConfirm(
      "Discard All Changes",
      'Discard <strong>all</strong> unstaged changes?<br><span class="warn">This cannot be undone.</span>',
      "Discard All",
      true,
      async function() {
        try {
          var token = await getApprovalToken("git.discard_all", "Discard all unstaged changes");
          if (!token) return;
          await api("/api/git/discard-all", { method: "POST", headers: { "X-Approval-Token": token } });
          addSystemMessage("All unstaged changes discarded", "info");
          await loadGitStatus();
        } catch (e) { addSystemMessage("Discard failed", "error"); }
      }
    );
  });

  /* ── Stash ───────────────────────────────────────────── */
  async function refreshStashBtn() {
    try {
      var res = await api("/api/git/stash/list");
      var data = await res.json();
      var count = data.stashes ? data.stashes.length : 0;
      gitStashPopBtn.disabled = count === 0;
      gitStashPopBtn.textContent = count > 0 ? "Pop (" + count + ")" : "Pop";
      var hasChanges = cachedGitStatus && (cachedGitStatus.staged.length + cachedGitStatus.unstaged.length + cachedGitStatus.untracked.length) > 0;
      gitStashBtn.disabled = !hasChanges;
    } catch (e) {
      gitStashPopBtn.disabled = true;
    }
  }

  gitStashBtn.addEventListener("click", async function() {
    gitStashBtn.disabled = true;
    gitStashBtn.textContent = "Stashing…";
    try {
      var res = await api("/api/git/stash", { method: "POST", body: JSON.stringify({}) });
      var data = await res.json();
      if (res.ok) {
        addSystemMessage(data.output || "Changes stashed", "success");
        await loadGitStatus();
      } else {
        addSystemMessage("Stash failed: " + (data.error || "unknown"), "error");
      }
    } catch (e) {
      addSystemMessage("Stash failed", "error");
    }
    gitStashBtn.textContent = "Stash";
  });

  gitStashPopBtn.addEventListener("click", async function() {
    gitStashPopBtn.disabled = true;
    gitStashPopBtn.textContent = "Popping…";
    try {
      var res = await api("/api/git/stash/pop", { method: "POST", body: JSON.stringify({}) });
      var data = await res.json();
      if (res.ok) {
        addSystemMessage(data.output || "Stash popped", "success");
        await loadGitStatus();
      } else {
        addSystemMessage("Stash pop failed: " + (data.error || "unknown"), "error");
        refreshStashBtn();
      }
    } catch (e) {
      addSystemMessage("Stash pop failed", "error");
      refreshStashBtn();
    }
  });

  /* ── Commit ──────────────────────────────────────────── */
  gitCommitBtn.addEventListener("click", async function() {
    var msg = gitCommitMsg.value.trim();
    if (!msg) return;
    gitCommitBtn.disabled = true;
    gitCommitBtn.textContent = "Committing…";
    try {
      var res = await api("/api/git/commit", { method: "POST", body: JSON.stringify({ message: msg }) });
      var data = await res.json();
      if (res.ok) {
        gitCommitMsg.value = "";
        gitCommitMsg.style.height = "auto";
        addSystemMessage("Committed: " + (data.summary || data.hash), "success");
        await loadGitStatus();
      } else {
        addSystemMessage("Commit failed: " + (data.error || "unknown error"), "error");
        updateCommitBtn();
      }
    } catch (e) {
      addSystemMessage("Commit failed", "error");
      updateCommitBtn();
    }
  });

  /* ── Push / Fetch ─────────────────────────────────────── */
  var PROD_BRANCHES = ["main", "master", "production", "prod", "release"];
  var STAGING_BRANCHES = ["staging", "stage", "develop", "dev", "qa", "uat", "pre-prod", "preprod"];

  function getBranchEnv(branchName) {
    if (!branchName) return null;
    if (PROD_BRANCHES.indexOf(branchName) >= 0) return "production";
    if (STAGING_BRANCHES.indexOf(branchName) >= 0) return "staging";
    return null;
  }

  function updatePushRow(data) {
    if (!data) { gitPushRow.classList.add("hidden"); gitRemoteLabel.classList.add("hidden"); return; }

    var hasRemote = !!data.remote;
    if (hasRemote) {
      gitPushRow.classList.remove("hidden");
      gitRemoteLabel.textContent = "→ " + data.remote;
      gitRemoteLabel.classList.remove("hidden");
    } else {
      gitPushRow.classList.remove("hidden");
      gitRemoteLabel.textContent = "No upstream — push will set origin/" + data.branch;
      gitRemoteLabel.classList.remove("hidden");
    }

    var branchEnv = getBranchEnv(data.branch);
    var aheadCount = data.ahead || 0;

    gitPushBtn.disabled = aheadCount === 0 && hasRemote;

    var envClass = branchEnv === "production" ? " prod-push" : branchEnv === "staging" ? " staging-push" : "";
    gitPushBtn.className = "git-push-btn" + envClass;
    var label = branchEnv === "production" ? "Push to Production"
              : branchEnv === "staging" ? "Push to Staging"
              : "Push";
    var badge = aheadCount > 0 ? ' <span class="push-badge">' + aheadCount + '</span>' : "";
    gitPushBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> '
      + label + badge;
  }

  gitPushBtn.addEventListener("click", function() {
    if (!cachedGitStatus) return;
    var branch = cachedGitStatus.branch;
    var hasRemote = !!cachedGitStatus.remote;
    var branchEnv = getBranchEnv(branch);
    var ahead = cachedGitStatus.ahead || 0;
    var commitWord = ahead !== 1 ? "commits" : "commit";
    var remote = cachedGitStatus.remote || "origin/" + branch;

    if (branchEnv === "production") {
      showConfirm(
        "Push to Production",
        'You are about to push <strong>' + ahead + ' ' + commitWord + '</strong> to <code>' + remote + '</code>.'
          + '<br><br><span class="warn">This will deploy to production.</span>',
        "Push to Production",
        true,
        function() { doPush(false); }
      );
    } else if (branchEnv === "staging") {
      showConfirm(
        "Push to Staging",
        'You are about to push <strong>' + ahead + ' ' + commitWord + '</strong> to <code>' + remote + '</code>.'
          + '<br><br>This will deploy to the staging environment.',
        "Push to Staging",
        false,
        function() { doPush(false); }
      );
    } else if (!hasRemote) {
      showConfirm(
        "Set Upstream & Push",
        'Branch <code>' + escapeHtml(branch) + '</code> has no upstream.<br>This will push and set tracking to <code>origin/' + escapeHtml(branch) + '</code>.',
        "Push",
        false,
        function() { doPush(false); }
      );
    } else {
      doPush(false);
    }
  });

  async function doPush(force) {
    gitPushBtn.disabled = true;
    var origHtml = gitPushBtn.innerHTML;
    gitPushBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> Pushing…';
    try {
      var approvalToken = await getApprovalToken("git.push", force ? "Force push" : "Push commits");
      if (!approvalToken) throw new Error("approval_failed");
      var body = force ? JSON.stringify({ force: true }) : JSON.stringify({});
      var res = await api("/api/git/push", { method: "POST", headers: { "X-Approval-Token": approvalToken }, body: body });
      var data = await res.json();
      if (res.ok) {
        addSystemMessage(data.output || "Pushed successfully", "success");
        await loadGitStatus();
      } else {
        addSystemMessage("Push failed: " + (data.error || "unknown"), "error");
        gitPushBtn.innerHTML = origHtml;
        gitPushBtn.disabled = false;
      }
    } catch (e) {
      addSystemMessage("Push failed", "error");
      gitPushBtn.innerHTML = origHtml;
      gitPushBtn.disabled = false;
    }
  }

  gitFetchBtn.addEventListener("click", async function() {
    gitFetchBtn.disabled = true;
    gitFetchBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg> Fetching…';
    try {
      var res = await api("/api/git/fetch", { method: "POST" });
      var data = await res.json();
      if (res.ok) {
        addSystemMessage(data.output || "Fetched", "info");
        await loadGitStatus();
      } else {
        addSystemMessage("Fetch failed: " + (data.error || "unknown"), "error");
      }
    } catch (e) {
      addSystemMessage("Fetch failed", "error");
    }
    gitFetchBtn.disabled = false;
    gitFetchBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg> Fetch';
  });

  /* ── Diff View ───────────────────────────────────────── */
  var currentDiffFile = null;
  var currentDiffStaged = false;

  function openDiffView(filePath, staged, untracked) {
    currentDiffFile = filePath;
    currentDiffStaged = staged;
    gitDiffFilename.textContent = filePath;
    gitDiffContent.innerHTML = '<span style="color:var(--text-3)">Loading diff…</span>';

    if (staged) {
      gitDiffAction.className = "git-diff-action-btn unstage-btn";
      gitDiffAction.textContent = "Unstage " + filePath.split("/").pop();
    } else {
      gitDiffAction.className = "git-diff-action-btn stage-btn";
      gitDiffAction.textContent = "Stage " + filePath.split("/").pop();
    }

    gitDiffView.classList.add("open");
    loadDiff(filePath, staged, untracked);
  }

  function closeDiffView() {
    gitDiffView.classList.remove("open");
    currentDiffFile = null;
  }

  gitDiffBack.addEventListener("click", closeDiffView);

  gitDiffAction.addEventListener("click", async function() {
    if (!currentDiffFile) return;
    if (currentDiffStaged) {
      await unstageFiles([currentDiffFile]);
    } else {
      await stageFiles([currentDiffFile]);
    }
    closeDiffView();
  });

  async function loadDiff(filePath, staged, untracked) {
    try {
      var url = "/api/git/diff?file=" + encodeURIComponent(filePath);
      if (staged) url += "&staged=1";
      if (untracked) url += "&untracked=1";
      var res = await api(url);
      if (!res.ok) {
        var err = await res.json();
        gitDiffContent.innerHTML = '<span style="color:var(--error)">' + escapeHtml(err.error || "Error loading diff") + '</span>';
        return;
      }
      var data = await res.json();
      if (!data.diff || data.diff.trim() === "") {
        gitDiffContent.innerHTML = '<span style="color:var(--text-3)">No changes</span>';
        return;
      }
      renderDiff(data.diff);
    } catch (e) {
      gitDiffContent.innerHTML = '<span style="color:var(--error)">Failed to load diff</span>';
    }
  }

  function renderDiff(diffText) {
    var lines = diffText.split("\n");
    var html = "";
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cls = "diff-ctx";
      if (line.startsWith("@@")) cls = "diff-hunk";
      else if (line.startsWith("+")) cls = "diff-add";
      else if (line.startsWith("-")) cls = "diff-del";
      html += '<div class="diff-line ' + cls + '">' + escapeHtml(line) + '</div>';
    }
    gitDiffContent.innerHTML = html;
  }

  /* ── Git Log ─────────────────────────────────────────── */
  async function loadGitLog(version) {
    gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Loading…</div></div>';
    try {
      var res = await api("/api/git/log?count=30");
      if (version !== tabLoadVersion) return;
      if (!res.ok) {
        var err = await res.json();
        gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">' + escapeHtml(err.error || "Error") + '</div></div>';
        return;
      }
      var data = await res.json();
      if (!data.commits || data.commits.length === 0) {
        gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">No commits yet</div></div>';
        return;
      }

      var html = "";
      data.commits.forEach(function(c, idx) {
        html += '<div class="git-log-entry">'
          + '<div class="git-log-msg">' + escapeHtml(c.message) + '</div>'
          + '<div class="git-log-meta">'
          + '<span class="git-log-hash">' + escapeHtml(c.short) + '</span>'
          + '<span>' + escapeHtml(c.author) + '</span>'
          + '<span>' + escapeHtml(c.date) + '</span>';
        if (idx === 0) {
          html += '<button class="git-branch-merge-btn" id="git-undo-commit-btn">Undo</button>';
        }
        html += '</div></div>';
      });
      gitBody.innerHTML = html;

      var undoBtn = document.getElementById("git-undo-commit-btn");
      if (undoBtn) {
        undoBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          showConfirm(
            "Undo Last Commit",
            'Undo the most recent commit? Changes will be kept as staged files (soft reset).',
            "Undo Commit",
            false,
            function() { undoLastCommit("soft"); }
          );
        });
      }
    } catch (e) {
      gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Failed to load log</div></div>';
    }
  }

  /* ── Reusable Confirm Dialog ──────────────────────── */
  function showConfirm(title, descHtml, okLabel, isDanger, callback) {
    gitConfirmTitle.textContent = title;
    gitConfirmDesc.innerHTML = descHtml;
    gitConfirmOk.textContent = okLabel;
    gitConfirmOk.className = isDanger ? "git-confirm-danger" : "git-confirm-go";
    confirmCallback = callback;
    gitConfirmOverlay.classList.remove("hidden");
  }

  gitConfirmCancel.addEventListener("click", function() {
    confirmCallback = null;
    gitConfirmOverlay.classList.add("hidden");
  });

  gitConfirmOk.addEventListener("click", function() {
    var cb = confirmCallback;
    confirmCallback = null;
    gitConfirmOverlay.classList.add("hidden");
    if (cb) cb();
  });

  /* ── Branches ─────────────────────────────────────── */
  async function loadGitBranches(version) {
    gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Loading…</div></div>';
    try {
      var res = await api("/api/git/branches");
      if (version !== tabLoadVersion) return;
      if (!res.ok) {
        var err = await res.json();
        gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">' + escapeHtml(err.error || "Error") + '</div></div>';
        return;
      }
      var data = await res.json();
      if (!data.branches || data.branches.length === 0) {
        gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">No branches found</div></div>';
        return;
      }

      var html = '';
      data.branches.forEach(function(b) {
        var dotCls = b.current ? "active" : "";
        var nameCls = b.current ? "current" : "";
        html += '<div class="git-branch-row" data-branch="' + escapeHtml(b.name) + '" data-current="' + (b.current ? "1" : "0") + '">'
          + '<span class="git-branch-current ' + dotCls + '"></span>'
          + '<span class="git-branch-name ' + nameCls + '">' + escapeHtml(b.name) + '</span>';
        if (!b.current) {
          html += '<button class="git-branch-delete-btn" data-delete-branch="' + escapeHtml(b.name) + '" title="Delete branch">'
            + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
            + '</button>'
            + '<button class="git-branch-merge-btn" data-merge-branch="' + escapeHtml(b.name) + '">Merge</button>';
        }
        html += '</div>';
      });

      gitBody.innerHTML = html;
      bindBranchEvents();
    } catch (e) {
      gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Failed to load branches</div></div>';
    }
  }

  function bindBranchEvents() {
    gitBody.querySelectorAll(".git-branch-merge-btn").forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var branch = btn.dataset.mergeBranch;
        var currentBr = gitBranch.textContent || "current branch";
        showConfirm(
          "Merge Branch",
          'Merge <code>' + escapeHtml(branch) + '</code> into <code>' + escapeHtml(currentBr) + '</code>?',
          "Merge",
          false,
          function() { doMerge(branch); }
        );
      });
    });

    gitBody.querySelectorAll(".git-branch-delete-btn").forEach(function(btn) {
      btn.addEventListener("click", function(e) {
        e.stopPropagation();
        var branch = btn.dataset.deleteBranch;
        showConfirm(
          "Delete Branch",
          'Delete branch <code>' + escapeHtml(branch) + '</code>?<br>Use force delete if the branch has unmerged changes.',
          "Delete",
          true,
          function() { deleteBranch(branch, false); }
        );
      });
    });

    gitBody.querySelectorAll(".git-branch-row").forEach(function(row) {
      row.addEventListener("click", function() {
        if (row.dataset.current === "1") return;
        checkoutBranch(row.dataset.branch);
      });
    });
  }

  async function checkoutBranch(branch) {
    gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Switching to ' + escapeHtml(branch) + '…</div></div>';
    try {
      var res = await api("/api/git/checkout", { method: "POST", body: JSON.stringify({ branch: branch }) });
      var data = await res.json();
      if (res.ok) {
        gitBranch.textContent = branch;
        addSystemMessage("Switched to branch: " + branch, "success");
        loadGitBranches();
      } else {
        addSystemMessage("Checkout failed: " + (data.error || "unknown"), "error");
        loadGitBranches();
      }
    } catch (e) {
      addSystemMessage("Checkout failed", "error");
      loadGitBranches();
    }
  }

  async function deleteBranch(branch, force) {
    try {
      var approvalToken = await getApprovalToken("git.branch_delete", "Delete branch " + branch + (force ? " (force)" : ""));
      if (!approvalToken) return;
      var res = await api("/api/git/branch/delete", { method: "POST", headers: { "X-Approval-Token": approvalToken }, body: JSON.stringify({ name: branch, force: force }) });
      var data = await res.json();
      if (res.ok) {
        addSystemMessage("Deleted branch: " + branch, "success");
      } else {
        var errMsg = data.error || "unknown";
        if (errMsg.includes("not fully merged")) {
          showConfirm(
            "Force Delete?",
            'Branch <code>' + escapeHtml(branch) + '</code> is not fully merged.<br><span class="warn">Force deleting will lose unmerged commits.</span>',
            "Force Delete",
            true,
            function() { deleteBranch(branch, true); }
          );
          return;
        }
        addSystemMessage("Delete failed: " + errMsg, "error");
      }
    } catch (e) {
      addSystemMessage("Delete failed", "error");
    }
    loadGitBranches();
  }

  /* ── Create Branch ──────────────────────────────────── */
  gitNewBranchName.addEventListener("input", function() {
    gitCreateBranchBtn.disabled = gitNewBranchName.value.trim().length === 0;
  });

  gitCreateBranchBtn.addEventListener("click", async function() {
    var name = gitNewBranchName.value.trim();
    if (!name) return;
    gitCreateBranchBtn.disabled = true;
    gitCreateBranchBtn.textContent = "Creating…";
    try {
      var res = await api("/api/git/branch/create", { method: "POST", body: JSON.stringify({ name: name }) });
      var data = await res.json();
      if (res.ok) {
        gitNewBranchName.value = "";
        gitBranch.textContent = name;
        addSystemMessage("Created and switched to branch: " + name, "success");
        loadGitBranches();
      } else {
        addSystemMessage("Create branch failed: " + (data.error || "unknown"), "error");
      }
    } catch (e) {
      addSystemMessage("Create branch failed", "error");
    }
    gitCreateBranchBtn.textContent = "Create";
    gitCreateBranchBtn.disabled = gitNewBranchName.value.trim().length === 0;
  });

  gitNewBranchName.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !gitCreateBranchBtn.disabled) gitCreateBranchBtn.click();
  });

  /* ── Merge ──────────────────────────────────────────── */
  async function doMerge(branch) {
    gitBody.innerHTML = '<div class="git-empty"><div class="git-empty-text">Merging ' + escapeHtml(branch) + '…</div></div>';
    try {
      var approvalToken = await getApprovalToken("git.merge", "Merge branch " + branch);
      if (!approvalToken) throw new Error("approval_failed");
      var res = await api("/api/git/merge", { method: "POST", headers: { "X-Approval-Token": approvalToken }, body: JSON.stringify({ branch: branch }) });
      var data = await res.json();
      if (res.ok && data.success) {
        addSystemMessage("Merged " + branch + " successfully", "success");
      } else if (res.ok && !data.success) {
        addSystemMessage("Merge conflicts detected.\n\n" + (data.output || ""), "error");
        showConfirm(
          "Merge Conflict",
          'There are merge conflicts. You can resolve them and commit, or abort the merge to go back to the previous state.',
          "Abort Merge",
          true,
          function() { doMergeAbort(); }
        );
        loadGitBranches();
        return;
      } else {
        addSystemMessage("Merge failed: " + (data.error || "unknown"), "error");
      }
    } catch (e) {
      addSystemMessage("Merge failed", "error");
    }
    loadGitBranches();
  }

  async function doMergeAbort() {
    try {
      var res = await api("/api/git/merge/abort", { method: "POST" });
      if (res.ok) {
        addSystemMessage("Merge aborted", "info");
      } else {
        var data = await res.json();
        addSystemMessage("Abort failed: " + (data.error || "unknown"), "error");
      }
    } catch (e) {
      addSystemMessage("Abort failed", "error");
    }
    if (gitActiveTab === "changes") loadGitStatus();
    else if (gitActiveTab === "branches") loadGitBranches();
  }

  /* ── Undo Last Commit (Reset) ───────────────────────── */
  async function undoLastCommit(mode) {
    try {
      var approvalToken = await getApprovalToken("git.reset", "Git reset (" + mode + ")");
      if (!approvalToken) return;
      var res = await api("/api/git/reset", { method: "POST", headers: { "X-Approval-Token": approvalToken }, body: JSON.stringify({ mode: mode }) });
      var data = await res.json();
      if (res.ok) {
        var label = mode === "soft" ? "Undone (changes kept staged)" : mode === "mixed" ? "Undone (changes kept unstaged)" : "Undone (changes discarded)";
        addSystemMessage(label, "success");
      } else {
        addSystemMessage("Reset failed: " + (data.error || "unknown"), "error");
      }
    } catch (e) {
      addSystemMessage("Reset failed", "error");
    }
    if (gitActiveTab === "changes") loadGitStatus();
    else if (gitActiveTab === "log") loadGitLog();
  }

  /* ── Start ─────────────────────────────────────────── */
  checkAuth();
})();
