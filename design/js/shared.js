/* ─────────────────────────────────────────────────────────────────────────
 * OmniPanel — Shared Topbar: Command Palette + Notifications
 * Include AFTER page-specific scripts.
 * ─────────────────────────────────────────────────────────────────── */

(function() {
  // ─── Embed detection: strip chrome when loaded inside workspace iframe ──
  var isEmbedded = (/[?&]embed=1(?:&|$)/).test(window.location.search);
  if (isEmbedded) {
    // Hide all chrome: sidebar, topbar, statusbar, command palette
    var hideChrome = function() {
      var sidebar = document.querySelector('.sidebar');
      var topbar = document.querySelector('.topbar');
      var statusbar = document.querySelector('.statusbar');
      var app = document.querySelector('.app');
      if (sidebar) sidebar.style.display = 'none';
      if (topbar) topbar.style.display = 'none';
      if (statusbar) statusbar.style.display = 'none';
      // Fix grid layout: remove sidebar column + right-panel class
      if (app) {
        app.classList.remove('with-right-panel');
        app.style.gridTemplateColumns = '1fr';
      }
      // Make main-content fill the viewport
      var main = document.querySelector('.main-content');
      if (main) {
        main.style.height = '100vh';
        main.style.width = '100vw';
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', hideChrome);
    } else {
      hideChrome();
    }
    // Prevent workspace scripts from loading inside iframe
    document.body.setAttribute('data-workspace', 'false');
    // Still allow shared features (command palette, etc.) but skip chrome setup
  }

  // ─── Command Palette ─────────────────────────────────────────────────
  // Create palette overlay if not already present
  if (!document.getElementById('cmdPalette')) {
    const overlay = document.createElement('div');
    overlay.className = 'cmd-palette-overlay';
    overlay.id = 'cmdPalette';
    overlay.innerHTML = `
      <div class="cmd-palette">
        <input class="cmd-palette-input" placeholder="Search connections, commands, pages..." id="cmdInput">
        <div class="cmd-palette-list" id="cmdList">
          <div class="cmd-palette-item" data-href="index.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></div>
            <span class="item-label">Workspace</span>
            <span class="item-hint">Home</span>
          </div>
          <div class="cmd-palette-item" data-href="terminal.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg></div>
            <span class="item-label">Terminal</span>
            <span class="item-hint">Local</span>
          </div>
          <div class="cmd-palette-item" data-href="ssh.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
            <span class="item-label">prod-web-01</span>
            <span class="item-hint">SSH</span>
          </div>
          <div class="cmd-palette-item" data-href="database.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg></div>
            <span class="item-label">Database</span>
            <span class="item-hint">SQL</span>
          </div>
          <div class="cmd-palette-item" data-href="docker.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="6" height="5" rx="1"/><rect x="10" y="7" width="6" height="5" rx="1"/></svg></div>
            <span class="item-label">Docker</span>
            <span class="item-hint">Containers</span>
          </div>
          <div class="cmd-palette-item" data-href="server.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/></svg></div>
            <span class="item-label">Servers</span>
            <span class="item-hint">Monitor</span>
          </div>
          <div class="cmd-palette-item" data-href="protocol.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg></div>
            <span class="item-label">Protocol Lab</span>
            <span class="item-hint">HTTP / WS</span>
          </div>
          <div class="cmd-palette-item" data-href="workflow.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="3"/></svg></div>
            <span class="item-label">Workflow</span>
            <span class="item-hint">Automation</span>
          </div>
          <div class="cmd-palette-item" data-href="knowledge.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg></div>
            <span class="item-label">Knowledge</span>
            <span class="item-hint">Docs</span>
          </div>
          <div class="cmd-palette-item" data-href="tasks.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg></div>
            <span class="item-label">Tasks</span>
            <span class="item-hint">Queue</span>
          </div>
          <div class="cmd-palette-item" data-href="file-manager.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg></div>
            <span class="item-label">File Manager</span>
            <span class="item-hint">FTP / S3</span>
          </div>
          <div class="cmd-palette-item" data-href="settings.html">
            <div class="item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg></div>
            <span class="item-label">Settings</span>
            <span class="item-hint">Config</span>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Click overlay to close
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.classList.remove('show');
    });

    // Click item to navigate
    overlay.querySelectorAll('.cmd-palette-item[data-href]').forEach(function(item) {
      item.addEventListener('click', function() {
        var href = item.getAttribute('data-href');
        if (href) window.location.href = href;
      });
    });

    // Filter on input
    var cmdInput = overlay.querySelector('#cmdInput');
    if (cmdInput) {
      cmdInput.addEventListener('input', function() {
        var q = cmdInput.value.toLowerCase();
        overlay.querySelectorAll('.cmd-palette-item').forEach(function(item) {
          var label = item.querySelector('.item-label');
          var hint = item.querySelector('.item-hint');
          var text = (label ? label.textContent : '') + ' ' + (hint ? hint.textContent : '');
          item.style.display = text.toLowerCase().indexOf(q) !== -1 ? '' : 'none';
        });
      });
    }
  }

  // Toggle function
  window.toggleCmdPalette = function() {
    var el = document.getElementById('cmdPalette');
    if (!el) return;
    el.classList.toggle('show');
    if (el.classList.contains('show')) {
      var inp = el.querySelector('#cmdInput');
      if (inp) { inp.value = ''; inp.focus(); }
      // Show all items
      el.querySelectorAll('.cmd-palette-item').forEach(function(i) { i.style.display = ''; });
    }
  };

  // Keyboard shortcut
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      window.toggleCmdPalette();
    }
    if (e.key === 'Escape') {
      var el = document.getElementById('cmdPalette');
      if (el) el.classList.remove('show');
    }
  });

  // ─── Notification bell click ─────────────────────────────────────────
  window.handleNotifClick = function() {
    // If on index.html and drawer exists, toggle it
    var drawer = document.getElementById('notifDrawer');
    var overlay = document.getElementById('notifOverlay');
    if (drawer && overlay) {
      drawer.classList.toggle('open');
      overlay.classList.toggle('open');
    } else {
      // Navigate to index.html
      window.location.href = 'index.html';
    }
  };

  // ─── Workspace embed (status bar entry, default off) ───────────────────
  if (document.body.getAttribute('data-workspace') !== 'false'
      && document.querySelector('.main-content .statusbar')
      && !document.querySelector('link[href*="workspace.css"]')) {
    var wsCss = document.createElement('link');
    wsCss.rel = 'stylesheet';
    wsCss.href = 'css/workspace.css';
    document.head.appendChild(wsCss);
    function loadWsScript(src, done) {
      if (document.querySelector('script[src="' + src + '"]')) {
        if (done) done();
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.onload = done || null;
      document.body.appendChild(s);
    }
    loadWsScript('js/workspace-engine.js', function () {
      loadWsScript('js/workspace-host.js', function () {
        if (global.initWorkspaceHost) global.initWorkspaceHost();
      });
    });
  }
})();
