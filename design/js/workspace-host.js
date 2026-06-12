/* OmniPanel — Workspace Host (embedded in main window) */
(function (global) {
  'use strict';

  var STATE = { OFF: 'off', HALF: 'half', FULL: 'full' };

  var ICONS = {
    expand: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 3H5a2 2 0 00-2 2v8"/><path d="M7 3v3H4"/></svg>',
    shrink: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 13V5a2 2 0 012-2h8"/><path d="M12 10h3v3"/></svg>',
    home: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 8l5-5 5 5"/><path d="M5 7v6a1 1 0 001 1h4a1 1 0 001-1V7"/></svg>'
  };

  function defaultWorkspaces() {
    var left = {
      id: 'pane-1', kind: 'pane',
      tabs: [
        { id: 't1', type: 'terminal', title: 'local ~' },
        { id: 't2', type: 'logs', title: 'api-gateway' }
      ],
      activeTabId: 't1'
    };
    var right = {
      id: 'pane-2', kind: 'pane',
      tabs: [
        { id: 't3', type: 'sql', title: 'prod-db' }
      ],
      activeTabId: 't3'
    };
    return [
      {
        id: 'ws-1',
        name: '故障排查',
        root: {
          id: 'split-1', kind: 'split', direction: 'horizontal', ratio: 0.52,
          first: left, second: right
        },
        focusedPaneId: 'pane-1'
      },
      {
        id: 'ws-2',
        name: '日常开发',
        root: {
          id: 'pane-3', kind: 'pane',
          tabs: [
            { id: 't5', type: 'terminal', title: 'ssh staging' },
            { id: 't6', type: 'knowledge', title: 'Deploy Runbook' }
          ],
          activeTabId: 't5'
        },
        focusedPaneId: 'pane-3'
      }
    ];
  }

  function WorkspaceHost(options) {
    options = options || {};
    this.mainContent = options.mainContent || document.querySelector('.main-content');
    this.statusbar = options.statusbar || (this.mainContent && this.mainContent.querySelector('.statusbar'));
    this.state = STATE.OFF;
    this.engine = null;
    this.embedWrap = null;
    this.toggleBtn = null;
    this.modeBtn = null;
    this.topbar = null;
    this.topbarHost = null;
    this.topbarPageActions = null;
    this.topbarTitle = null;
    this.topbarTabs = null;
    this.isHome = !!document.getElementById('homeDashboard');
    this._homeActive = false; // true when home dashboard is shown
  }

  WorkspaceHost.prototype.init = function () {
    if (!this.mainContent || !this.statusbar || typeof global.WorkspaceEngine === 'undefined') return this;

    this.setupTopbarIntegration();
    this.wrapViewport();
    this.createEmbedShell();
    this.injectStatusToggle();
    this.bindEvents();

    // Default to full workspace (home = workspace)
    var startState = this.mainContent.getAttribute('data-ws-start');
    if (startState === 'off') {
      this.applyState(STATE.OFF);
    } else {
      this.goHome();
    }
    return this;
  };

  WorkspaceHost.prototype.setupTopbarIntegration = function () {
    if (!this.mainContent) return;
    this.topbar = this.mainContent.querySelector('.topbar');
    if (!this.topbar || this.topbarHost) return;

    this.topbarTitle = this.topbar.querySelector('.topbar-title');
    this.topbarTabs = this.topbar.querySelector('.topbar-tabs');
    this.topbarPageActions = this.topbar.querySelector('.topbar-page-actions');
    this.topbarRight = this.topbar.querySelector('.topbar-right');

    var host = document.createElement('div');
    host.className = 'topbar-ws-host';
    host.id = 'wsTopbarHost';
    host.hidden = true;

    if (this.topbarRight) {
      this.topbar.insertBefore(host, this.topbarRight);
    } else {
      this.topbar.appendChild(host);
    }
    this.topbarHost = host;

    if (this.topbarPageActions && !this.topbarPageActions.querySelector('#wsPageActionsSlot')) {
      var slot = document.createElement('span');
      slot.className = 'topbar-ws-tools';
      slot.id = 'wsPageActionsSlot';
      slot.hidden = true;
      this.topbarPageActions.insertBefore(slot, this.topbarPageActions.firstChild);
      this.pageActionsSlot = slot;
    } else {
      this.pageActionsSlot = this.topbarPageActions && this.topbarPageActions.querySelector('#wsPageActionsSlot');
    }
  };

  WorkspaceHost.prototype.wrapViewport = function () {
    if (this.mainContent.querySelector('.app-viewport')) return;

    var statusbar = this.statusbar;
    var toWrap = [];
    Array.prototype.forEach.call(this.mainContent.children, function (el) {
      if (el === statusbar) return;
      if (el.classList.contains('topbar')) return;
      if (el.id === 'wsEmbedWrap') return;
      // Keep home-dashboard outside viewport so it can be shown independently
      if (el.classList.contains('home-dashboard')) return;
      toWrap.push(el);
    });

    var wrap = document.createElement('div');
    wrap.className = 'app-viewport';
    wrap.id = 'appViewport';
    toWrap.forEach(function (el) { wrap.appendChild(el); });
    this.mainContent.insertBefore(wrap, statusbar);
  };

  WorkspaceHost.prototype.createEmbedShell = function () {
    if (document.getElementById('wsEmbedWrap')) {
      this.embedWrap = document.getElementById('wsEmbedWrap');
      return;
    }

    var shell = document.createElement('div');
    shell.className = 'ws-embed-wrap';
    shell.id = 'wsEmbedWrap';
    shell.innerHTML =
      '<div class="ws-iframe-slot" id="wsIframeSlot"></div>' +
      '<div class="ws-embed-mount" id="wsMount"></div>';

    this.mainContent.insertBefore(shell, this.statusbar);
    this.embedWrap = shell;
  };

  WorkspaceHost.prototype.injectStatusToggle = function () {
    if (this.statusbar.querySelector('.statusbar-ws-toggle')) {
      this.toggleBtn = this.statusbar.querySelector('.statusbar-ws-toggle');
      return;
    }

    var btn = document.createElement('button');
    btn.className = 'statusbar-item statusbar-ws-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', '切换工作区');
    btn.innerHTML =
      '<span class="ws-indicator"></span>' +
      '<span class="ws-toggle-label">工作区</span>';

    this.statusbar.appendChild(btn);
    this.toggleBtn = btn;
  };

  WorkspaceHost.prototype.ensureEngine = function () {
    if (this.engine) return;
    var mount = document.getElementById('wsMount');
    if (!mount) return;

    var self = this;
    this.engine = new global.WorkspaceEngine({
      mode: 'half',
      embedded: true,
      mount: mount,
      topbarMount: this.topbarHost,
      pageActionsMount: this.topbarPageActions,
      workspaces: defaultWorkspaces(),
      onRender: function () { self.afterEngineRender(); }
    });
    this.engine.activeWorkspaceId = 'ws-1';
    this.engine.render();
  };

  WorkspaceHost.prototype.syncTopbarMode = function () {
    if (!this.topbar) return;
    var isFull = this.state === STATE.FULL;

    // Home dashboard state: show workspace host with "首页" label, hide title/tabs
    if (this._homeActive) {
      this.topbar.classList.add('topbar-ws-mode');
      if (this.topbarTitle) this.topbarTitle.hidden = true;
      if (this.topbarTabs) this.topbarTabs.hidden = true;
      if (this.topbarHost) this.topbarHost.hidden = false;
      if (this.pageActionsSlot) this.pageActionsSlot.hidden = true;
      // Update trigger text to "首页" and set engine home mode
      if (this.engine) {
        this.engine._homeMode = true;
        var triggerName = this.topbarHost.querySelector('.ws-ws-trigger-name');
        if (triggerName) triggerName.textContent = '首页';
        var trigger = this.topbarHost.querySelector('.ws-ws-trigger');
        if (trigger) trigger.classList.add('ws-home-trigger');
      }
      return;
    }

    // Not home — clear home mode flag
    if (this.engine) this.engine._homeMode = false;

    this.topbar.classList.toggle('topbar-ws-mode', isFull);

    if (this.topbarTitle) this.topbarTitle.hidden = isFull;
    if (this.topbarTabs) this.topbarTabs.hidden = isFull;
    if (this.topbarHost) this.topbarHost.hidden = !isFull;
    if (this.pageActionsSlot) this.pageActionsSlot.hidden = !isFull;

    if (!isFull) {
      if (this.topbarHost) this.topbarHost.innerHTML = '';
      if (this.pageActionsSlot) this.pageActionsSlot.innerHTML = '';
    }
  };

  WorkspaceHost.prototype.afterEngineRender = function () {
    this.injectModeButton();
    this.updateStatusLabel();
  };

  WorkspaceHost.prototype.findModeSlot = function () {
    if (this.state === STATE.FULL && this.pageActionsSlot) {
      return this.pageActionsSlot.querySelector('[data-ws-actions]');
    }
    if (this.engine && this.engine.mountEl) {
      return this.engine.mountEl.querySelector('[data-ws-actions]');
    }
    return null;
  };

  WorkspaceHost.prototype.injectModeButton = function () {
    if (this.state !== STATE.HALF && this.state !== STATE.FULL) return;

    var slot = this.findModeSlot();
    if (!slot) return;

    var self = this;
    if (!this.modeBtn) {
      this.modeBtn = document.createElement('button');
      this.modeBtn.className = 'ws-mode-btn-inline';
      this.modeBtn.type = 'button';
      this.modeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (self.state === STATE.HALF) self.applyState(STATE.FULL);
        else if (self.state === STATE.FULL) self.applyState(STATE.HALF);
      });
    }

    this.modeBtn.innerHTML = this.state === STATE.FULL ? ICONS.shrink : ICONS.expand;
    this.modeBtn.title = this.state === STATE.FULL ? '恢复半屏' : '展开全屏';
    this.modeBtn.setAttribute('aria-label', this.modeBtn.title);

    slot.innerHTML = '';
    slot.appendChild(this.modeBtn);
  };

  /** Inject "首页" button into the workspace topbar */
  WorkspaceHost.prototype.injectHomeButton = function () {
    if (!this.isHome || !this.engine) return;

    // Find the workspace picker in the topbar
    var trigger = this.topbarHost && this.topbarHost.querySelector('#wsWsTrigger');
    if (!trigger) return;

    // Check if the home button already exists
    if (this.topbarHost.querySelector('.ws-home-btn')) return;

    // Create home button and insert after the workspace picker
    var self = this;
    var homeBtn = document.createElement('button');
    homeBtn.className = 'ws-tool-btn ws-home-btn';
    homeBtn.type = 'button';
    homeBtn.title = '首页';
    homeBtn.setAttribute('aria-label', '首页');
    homeBtn.innerHTML = ICONS.home;
    homeBtn.style.cssText = 'margin-left: var(--sp-2);';
    homeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      self.showHomeDashboard();
    });

    // Insert after the workspace picker
    var picker = this.topbarHost.querySelector('.ws-workspace-picker');
    if (picker && picker.nextSibling) {
      picker.parentNode.insertBefore(homeBtn, picker.nextSibling);
    }
  };

  /** Show the home dashboard */
  WorkspaceHost.prototype.showHomeDashboard = function () {
    this._homeActive = true;
    var dashboard = document.getElementById('homeDashboard');
    var embedWrap = document.getElementById('wsEmbedWrap');
    var viewport = document.getElementById('appViewport');

    if (dashboard) dashboard.classList.add('active');
    if (embedWrap) embedWrap.style.display = 'none';
    if (viewport) viewport.style.display = 'none';

    // Mark logo as home-active, clear dock highlights
    this.clearDockActive();
    var logo = document.querySelector('.sidebar-logo');
    if (logo) logo.classList.add('home-active');

    // Update status label
    var label = this.toggleBtn && this.toggleBtn.querySelector('.ws-toggle-label');
    if (label) label.textContent = '首页';

    // Sync topbar — will show workspace host with "首页" label
    this.syncTopbarMode();
  };

  /** Hide the home dashboard and show workspace */
  WorkspaceHost.prototype.hideHomeDashboard = function () {
    this._homeActive = false;
    if (this.engine) this.engine._homeMode = false;
    var dashboard = document.getElementById('homeDashboard');
    if (dashboard) dashboard.classList.remove('active');
    // Don't restore embed-wrap/display here — let applyState handle it
  };

  /** Backward compat alias */
  WorkspaceHost.prototype.showHomeKanban = WorkspaceHost.prototype.showHomeDashboard;
  WorkspaceHost.prototype.hideHomeKanban = WorkspaceHost.prototype.hideHomeDashboard;

  WorkspaceHost.prototype.updateStatusLabel = function () {
    if (!this.toggleBtn || !this.engine) return;
    var ws = this.engine.getActiveWorkspace();
    var label = this.toggleBtn.querySelector('.ws-toggle-label');
    if (!label) return;

    if (this._homeActive) {
      label.textContent = '首页';
      return;
    }
    if (this.state === STATE.OFF) {
      label.textContent = '工作区';
      return;
    }
    if (ws) {
      label.textContent = this.state === STATE.FULL ? ws.name + ' · 全屏' : ws.name;
    }
  };

  WorkspaceHost.prototype.applyState = function (next) {
    this.state = next;
    this.mainContent.classList.remove('ws-state-off', 'ws-state-half', 'ws-state-full');
    this.mainContent.classList.add('ws-state-' + next);
    this.syncTopbarMode();

    if (this.toggleBtn) {
      var active = next !== STATE.OFF;
      this.toggleBtn.classList.toggle('active', active);
      this.toggleBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    if (next === STATE.OFF) {
      this.updateStatusLabel();
      return;
    }

    // Hide dashboard when entering workspace mode (unless going to home)
    if (!this._homeActive) {
      this.hideHomeDashboard();
      // Restore embed-wrap visibility (may have been hidden by home dashboard)
      var embedWrap = document.getElementById('wsEmbedWrap');
      if (embedWrap) embedWrap.style.display = '';
      var viewport = document.getElementById('appViewport');
      if (viewport) viewport.style.display = '';
    }

    this.ensureEngine();
    if (this.engine) {
      this.engine.mode = next === STATE.FULL ? 'full' : 'half';
      this.engine.render();
    } else {
      this.updateStatusLabel();
    }
  };

  WorkspaceHost.prototype.bindEvents = function () {
    var self = this;

    if (this.toggleBtn) {
      this.toggleBtn.addEventListener('click', function () {
        if (self._homeActive) {
          // If on home dashboard, clicking toggle goes to workspace
          self.hideHomeDashboard();
          self.applyState(STATE.FULL);
        } else if (self.state === STATE.OFF) {
          self.applyState(STATE.HALF);
        } else {
          self.applyState(STATE.OFF);
        }
      });
    }

    // Logo click → activate full workspace (home) + highlight dock
    var logo = document.querySelector('.sidebar-logo');
    if (logo) {
      logo.addEventListener('click', function (e) {
        e.preventDefault();
        self.goHome();
      });
    }

    // Dock item click → if workspace is active, load in iframe
    var sidebar = document.querySelector('.sidebar');
    if (sidebar) {
      sidebar.addEventListener('click', function (e) {
        var item = e.target.closest('.sidebar-item[href]');
        if (!item || item.classList.contains('home-dock-btn')) return;
        var href = item.getAttribute('href');
        if (!href) return;

        // Update dock highlight
        self.setDockActive(item);

        // If workspace is active (FULL or HALF), intercept and load in iframe
        if (self.state !== STATE.OFF) {
          e.preventDefault();
          self.navigateTo(href);
        }
        // If OFF, let the link navigate normally
      });
    }
  };

  /** Navigate to a page in half-screen workspace mode */
  WorkspaceHost.prototype.navigateTo = function (href) {
    // Hide dashboard when navigating to a page
    this.hideHomeDashboard();
    this.applyState(STATE.HALF);
    this.loadInIframe(href);
  };

  /** Load a URL in the workspace iframe (separate from engine mount) */
  WorkspaceHost.prototype.loadInIframe = function (href) {
    var slot = document.getElementById('wsIframeSlot');
    if (!slot) return;
    slot.classList.add('has-content');
    if (this.mainContent) this.mainContent.classList.add('ws-has-iframe');
    var iframe = slot.querySelector('iframe');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.style.cssText = 'flex:1;border:none;width:100%;height:100%;';
      slot.appendChild(iframe);
    }
    // Append ?embed=1 so the embedded page strips its chrome (sidebar, topbar, statusbar)
    var embedUrl = href.indexOf('?') !== -1 ? href + '&embed=1' : href + '?embed=1';
    iframe.src = embedUrl;
  };

  /** Go home = show home dashboard (full-screen workspace state) */
  WorkspaceHost.prototype.goHome = function () {
    // Clear all dock active states
    this.clearDockActive();
    // Mark logo as home-active
    var logo = document.querySelector('.sidebar-logo');
    if (logo) logo.classList.add('home-active');
    // Clear iframe slot
    var slot = document.getElementById('wsIframeSlot');
    if (slot) {
      slot.innerHTML = '';
      slot.classList.remove('has-content');
    }
    if (this.mainContent) this.mainContent.classList.remove('ws-has-iframe');
    // Set state class (home = full workspace state)
    this.state = STATE.FULL;
    this.mainContent.classList.remove('ws-state-off', 'ws-state-half', 'ws-state-full');
    this.mainContent.classList.add('ws-state-full');
    // Initialize engine BEFORE setting home mode (engine must exist for topbar rendering)
    this.ensureEngine();
    if (this.engine) {
      this.engine.mode = 'full';
      this.engine._homeMode = true;
      this.engine.render();
    }
    // Hide embed-wrap when showing home dashboard
    var embedWrap = document.getElementById('wsEmbedWrap');
    if (embedWrap) embedWrap.style.display = 'none';
    var viewport = document.getElementById('appViewport');
    if (viewport) viewport.style.display = 'none';
    // Show the home dashboard (includes syncTopbarMode)
    this.showHomeDashboard();
    // Update statusbar toggle
    if (this.toggleBtn) {
      this.toggleBtn.classList.add('active');
      this.toggleBtn.setAttribute('aria-pressed', 'true');
    }
  };

  /** Set active dock item */
  WorkspaceHost.prototype.setDockActive = function (el) {
    this.clearDockActive();
    // Remove home-active from logo when a dock item is selected
    var logo = document.querySelector('.sidebar-logo');
    if (logo) logo.classList.remove('home-active');
    if (el) el.classList.add('active');
  };

  /** Clear all dock active states */
  WorkspaceHost.prototype.clearDockActive = function () {
    var items = document.querySelectorAll('.sidebar-item');
    items.forEach(function (item) { item.classList.remove('active'); });
  };

  global.WorkspaceHost = WorkspaceHost;

  function autoInit() {
    if (global.__wsHostInstance) return;
    if (document.body.getAttribute('data-workspace') === 'false') return;
    if (!document.querySelector('.main-content .statusbar')) return;
    if (typeof global.WorkspaceEngine === 'undefined') return;
    global.__wsHostInstance = new WorkspaceHost().init();
  }

  global.initWorkspaceHost = autoInit;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
})(window);
