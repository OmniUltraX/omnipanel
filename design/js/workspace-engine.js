/* OmniPanel Workspace Engine — tabs, tree splits, panel types */
(function (global) {
  'use strict';

  var PANEL_TYPES = {
    terminal: { label: 'Terminal', icon: 'term' },
    sql: { label: 'SQL 查询', icon: 'sql' },
    logs: { label: '日志窗口', icon: 'logs' },
    docker: { label: 'Docker', icon: 'docker' },
    knowledge: { label: '知识库', icon: 'kb' }
  };

  var ICONS = {
    term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>',
    sql: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>',
    logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
    docker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="6" height="5" rx="1"/><rect x="10" y="7" width="6" height="5" rx="1"/><rect x="18" y="7" width="4" height="5" rx="1"/></svg>',
    kb: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>',
    splitH: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M12 3v18"/></svg>',
    splitV: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 12h18"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
    cornerUp: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 3H5a2 2 0 00-2 2v8"/><path d="M7 3v3H4"/></svg>',
    cornerDown: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 13V5a2 2 0 012-2h8"/><path d="M12 10h3v3"/></svg>'
  };

  var uid = 0;
  function nextId(prefix) { uid += 1; return prefix + '-' + uid; }

  function createTab(type, title) {
    var meta = PANEL_TYPES[type] || PANEL_TYPES.terminal;
    return { id: nextId('tab'), type: type, title: title || meta.label };
  }

  function createPane(tabs, activeTabId) {
    return {
      id: nextId('pane'),
      kind: 'pane',
      tabs: tabs || [createTab('terminal')],
      activeTabId: activeTabId || null
    };
  }

  function createSplit(direction, first, second, ratio) {
    return {
      id: nextId('split'),
      kind: 'split',
      direction: direction,
      ratio: ratio == null ? 0.5 : ratio,
      first: first,
      second: second
    };
  }

  function ensureActiveTab(pane) {
    if (!pane.activeTabId && pane.tabs.length) {
      pane.activeTabId = pane.tabs[0].id;
    }
  }

  function findPaneById(node, paneId) {
    if (node.kind === 'pane') {
      return node.id === paneId ? node : null;
    }
    return findPaneById(node.first, paneId) || findPaneById(node.second, paneId);
  }

  function walkPanes(node, fn) {
    if (node.kind === 'pane') {
      fn(node);
      return;
    }
    walkPanes(node.first, fn);
    walkPanes(node.second, fn);
  }

  function defaultWorkspace(name) {
    var rootPane = createPane([
      createTab('terminal', 'local ~'),
      createTab('sql', 'prod-db'),
      createTab('logs', 'api-gateway')
    ]);
    ensureActiveTab(rootPane);
    return {
      id: nextId('ws'),
      name: name,
      root: rootPane,
      focusedPaneId: rootPane.id
    };
  }

  function panelHTML(tab) {
    switch (tab.type) {
      case 'terminal':
        return (
          '<div class="panel-content panel-terminal" data-panel="terminal">' +
          '<span class="prompt">chaoj@devbox</span>:<span class="cmd">~/omnipanel</span>$ git status\n' +
          '<span class="out">On branch feat/workspace\n' +
          'Changes not staged:\n' +
          '  modified:   src/workspace/split-tree.ts\n' +
          '  modified:   src/workspace/tab-bar.tsx</span>\n\n' +
          '<span class="prompt">chaoj@devbox</span>:<span class="cmd">~/omnipanel</span>$ docker compose ps\n' +
          '<span class="out">NAME            STATUS    PORTS\n' +
          'nginx-proxy     running   0.0.0.0:443->443/tcp\n' +
          'api-gateway     running   0.0.0.0:8080->8080/tcp\n' +
          'postgres        running   5432/tcp</span>\n\n' +
          '<span class="prompt">chaoj@devbox</span>:<span class="cmd">~/omnipanel</span>$ <span class="cursor"></span></div>' +
          '<div class="term-input-row"><span class="prompt">$</span><input type="text" placeholder="输入命令…" aria-label="终端命令"></div>'
        );
      case 'sql':
        return (
          '<div class="panel-content panel-sql">' +
          '<div class="panel-sql-editor">SELECT o.id, o.status, u.email\n' +
          'FROM orders o\n' +
          'JOIN users u ON u.id = o.user_id\n' +
          'WHERE o.created_at > NOW() - INTERVAL \'24 hours\'\n' +
          'ORDER BY o.created_at DESC\n' +
          'LIMIT 50;</div>' +
          '<div class="panel-sql-toolbar">' +
          '<button class="btn btn-primary btn-sm" type="button">执行 ⌘↵</button>' +
          '<span class="text-muted" style="font-size:10px;">prod-db · postgres · 42ms</span>' +
          '</div>' +
          '<div class="panel-sql-results"><table>' +
          '<thead><tr><th>id</th><th>status</th><th>email</th></tr></thead>' +
          '<tbody>' +
          '<tr><td>88421</td><td>shipped</td><td>alice@corp.io</td></tr>' +
          '<tr><td>88419</td><td>pending</td><td>bob@startup.dev</td></tr>' +
          '<tr><td>88415</td><td>refunded</td><td>carol@agency.co</td></tr>' +
          '</tbody></table></div></div>'
        );
      case 'logs':
        return (
          '<div class="panel-content panel-logs">' +
          '<div class="log-line"><span class="log-ts">14:32:01.042</span><span class="log-level info">INFO</span><span class="log-msg">api-gateway started on :8080</span></div>' +
          '<div class="log-line"><span class="log-ts">14:32:04.118</span><span class="log-level info">INFO</span><span class="log-msg">connected to postgres prod-db-master:5432</span></div>' +
          '<div class="log-line"><span class="log-ts">14:33:22.891</span><span class="log-level warn">WARN</span><span class="log-msg">rate limit threshold 80% — client 45.33.32.156</span></div>' +
          '<div class="log-line"><span class="log-ts">14:34:01.003</span><span class="log-level error">ERROR</span><span class="log-msg">checkout timeout order_id=88419 elapsed=30s</span></div>' +
          '<div class="log-line"><span class="log-ts">14:34:01.104</span><span class="log-level info">INFO</span><span class="log-msg">retry scheduled attempt=2 backoff=5s</span></div>' +
          '<div class="log-line"><span class="log-ts">14:34:06.221</span><span class="log-level info">INFO</span><span class="log-msg">checkout recovered order_id=88419 status=confirmed</span></div>' +
          '</div>'
        );
      case 'docker':
        return (
          '<div class="panel-content panel-docker">' +
          '<div class="docker-row"><span class="status-dot running"></span><span class="c-name">nginx-proxy</span><span class="c-meta">Up 3d · 443/tcp</span></div>' +
          '<div class="docker-row"><span class="status-dot running"></span><span class="c-name">api-gateway</span><span class="c-meta">Up 3d · 8080/tcp</span></div>' +
          '<div class="docker-row"><span class="status-dot running"></span><span class="c-name">postgres</span><span class="c-meta">Up 3d · 5432/tcp</span></div>' +
          '<div class="docker-row"><span class="status-dot stopped"></span><span class="c-name">celery-worker</span><span class="c-meta">Exited (137) · 2h ago</span></div>' +
          '</div>'
        );
      case 'knowledge':
        return (
          '<div class="panel-content panel-kb">' +
          '<div class="panel-kb-nav">' +
          '<div class="panel-kb-nav-item active">部署 Runbook</div>' +
          '<div class="panel-kb-nav-item">故障排查</div>' +
          '<div class="panel-kb-nav-item">SQL 片段</div>' +
          '</div>' +
          '<div class="panel-kb-body">' +
          '<h3>生产环境滚动发布</h3>' +
          '<p>标准发布流程：拉取镜像 → 健康检查 → 逐台替换 → 验证日志与指标。</p>' +
          '<div class="panel-kb-code"># 1. 拉取最新镜像\ndocker compose pull api-gateway\n\n# 2. 滚动更新\ndocker compose up -d --no-deps api-gateway\n\n# 3. 验证\n curl -sf localhost:8080/health</div>' +
          '</div></div>'
        );
      default:
        return '<div class="panel-content"><p class="text-muted">未知面板类型</p></div>';
    }
  }

  function WorkspaceEngine(options) {
    this.mode = options.mode || 'full';
    this.standalone = !!options.standalone;
    this.embedded = !!options.embedded;
    this.mountEl = options.mount;
    this.topbarMount = options.topbarMount || null;
    this.pageActionsMount = options.pageActionsMount || null;
    this.workspaces = options.workspaces || [
      defaultWorkspace('故障排查'),
      defaultWorkspace('日常开发')
    ];
    this.activeWorkspaceId = this.workspaces[0].id;
    this.onRender = options.onRender;
    this._addMenuOpen = false;
    this._wsMenuOpen = false;
    this._drag = null;
  }

  WorkspaceEngine.prototype._useExternalTopbar = function () {
    return this.mode === 'full' && this.embedded && this.topbarMount && !this.standalone;
  };

  WorkspaceEngine.prototype._getEventRoots = function () {
    var roots = [];
    if (this.mountEl) roots.push(this.mountEl);
    if (this._useExternalTopbar() && this.topbarMount) roots.push(this.topbarMount);
    if (this.pageActionsMount) {
      var slot = this.pageActionsMount.querySelector('#wsPageActionsSlot');
      if (slot) roots.push(slot);
    }
    return roots;
  };

  WorkspaceEngine.prototype._queryInRoots = function (selector) {
    var out = [];
    this._getEventRoots().forEach(function (root) {
      if (!root) return;
      root.querySelectorAll(selector).forEach(function (el) { out.push(el); });
    });
    return out;
  };

  WorkspaceEngine.prototype.getActiveWorkspace = function () {
    var self = this;
    return this.workspaces.find(function (w) { return w.id === self.activeWorkspaceId; });
  };

  WorkspaceEngine.prototype.render = function () {
    if (!this.mountEl) return;
    this.bindGlobalClose();
    var ws = this.getActiveWorkspace();
    if (!ws) return;

    var focused = findPaneById(ws.root, ws.focusedPaneId) || (ws.root.kind === 'pane' ? ws.root : null);
    var tabs = focused ? focused.tabs : [];
    var activeId = focused ? focused.activeTabId : null;

    if (this._useExternalTopbar()) {
      this.topbarMount.innerHTML = this.renderTopbarMain(ws, tabs, activeId) + this.renderAddMenu();
      this.renderExternalPageActions(ws);
      this.mountEl.innerHTML =
        '<div class="ws-chrome">' +
        '<div class="ws-tree-root" id="wsTreeRoot">' + this.renderNode(ws.root, ws) + '</div>' +
        '</div>';
    } else {
      var html = '<div class="ws-chrome">';
      html += this.renderToolbar(ws);
      html += '<div class="ws-tree-root" id="wsTreeRoot">' + this.renderNode(ws.root, ws) + '</div>';
      html += '</div>';
      html += this.renderAddMenu();
      this.mountEl.innerHTML = html;
    }

    this.bindEvents(ws);
    this._positionDropdowns();
    if (this.onRender) this.onRender(ws);
  };

  WorkspaceEngine.prototype.renderToolbar = function (ws) {
    var focused = findPaneById(ws.root, ws.focusedPaneId) || (ws.root.kind === 'pane' ? ws.root : null);
    var tabs = focused ? focused.tabs : [];
    var activeId = focused ? focused.activeTabId : null;
    var isFull = this.mode === 'full';

    if (isFull) {
      return this.renderFullTopbar(ws, tabs, activeId);
    }

    var html = '<div class="ws-chrome-bars">';
    html += '<div class="ws-toolbar">';
    html += '<div class="ws-workspace-picker">';
    html += '<button class="ws-ws-trigger" type="button" id="wsWsTrigger" aria-haspopup="true" aria-expanded="' + (this._wsMenuOpen ? 'true' : 'false') + '">';
    html += '<span class="ws-ws-trigger-name">' + ws.name + '</span>';
    html += '<svg class="ws-ws-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6l4 4 4-4"/></svg>';
    html += '</button>';
    html += this.renderWorkspaceMenu(ws);
    html += '</div>';
    html += '<div class="ws-toolbar-divider"></div>';
    html += '<div class="ws-tabs">';
    tabs.forEach(function (tab) {
      var meta = PANEL_TYPES[tab.type];
      html += '<div class="ws-tab' + (tab.id === activeId ? ' active' : '') + '" data-tab-id="' + tab.id + '" role="tab">';
      html += '<span class="tab-icon">' + ICONS[meta.icon] + '</span>';
      html += '<span class="tab-label">' + tab.title + '</span>';
      html += '<span class="tab-close" data-close-tab="' + tab.id + '" role="button" aria-label="关闭标签">' + ICONS.close + '</span>';
      html += '</div>';
    });
    html += '<button class="ws-add-tab" type="button" data-action="toggle-add-menu" title="添加标签" aria-label="添加标签">' + ICONS.plus + '</button>';
    html += '</div>';
    html += '<div class="ws-toolbar-group ws-toolbar-actions">';
    html += '<button class="ws-tool-btn" type="button" title="垂直分屏" data-action="split-v" aria-label="垂直分屏">' + ICONS.splitV + '</button>';
    html += '<button class="ws-tool-btn" type="button" title="水平分屏" data-action="split-h" aria-label="水平分屏">' + ICONS.splitH + '</button>';
    html += '<span data-ws-actions></span>';
    html += '</div>';
    html += '</div></div>';
    return html;
  };

  WorkspaceEngine.prototype.renderWorkspaceMenu = function (ws) {
    var isHome = this._homeMode;
    var html = '<div class="ws-ws-dropdown' + (this._wsMenuOpen ? ' open' : '') + '" id="wsWsDropdown" role="menu">';
    html += '<div class="ws-ws-dropdown-header">切换工作区</div>';
    // Home option at the top
    html += '<button class="ws-ws-dropdown-item ws-ws-dropdown-home-item' + (isHome ? ' active' : '') + '" type="button" data-action="show-home" role="menuitem">';
    html += '<span class="ws-ws-dropdown-name">首页</span>';
    if (isHome) html += '<span class="ws-ws-dropdown-check">✓</span>';
    html += '</button>';
    html += '<div class="ws-ws-dropdown-divider"></div>';
    this.workspaces.forEach(function (w) {
      html += '<button class="ws-ws-dropdown-item' + (!isHome && w.id === ws.id ? ' active' : '') + '" type="button" data-ws-id="' + w.id + '" role="menuitem">';
      html += '<span class="ws-ws-dropdown-name">' + w.name + '</span>';
      if (!isHome && w.id === ws.id) html += '<span class="ws-ws-dropdown-check">✓</span>';
      html += '</button>';
    });
    html += '<button class="ws-ws-dropdown-add" type="button" data-action="new-workspace" role="menuitem">' + ICONS.plus + '<span>新建工作区</span></button>';
    html += '</div>';
    return html;
  };

  WorkspaceEngine.prototype.renderTopbarMain = function (ws, tabs, activeId) {
    var triggerName = this._homeMode ? '首页' : ws.name;
    var html = '<div class="ws-topbar-inline" data-od-id="ws-topbar">';
    html += '<div class="ws-workspace-picker">';
    html += '<button class="ws-ws-trigger' + (this._homeMode ? ' ws-home-trigger' : '') + '" type="button" id="wsWsTrigger" aria-haspopup="true" aria-expanded="' + (this._wsMenuOpen ? 'true' : 'false') + '">';
    html += '<span class="ws-ws-trigger-name">' + triggerName + '</span>';
    html += '<svg class="ws-ws-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6l4 4 4-4"/></svg>';
    html += '</button>';
    html += this.renderWorkspaceMenu(ws);
    html += '</div>';
    // 首页模式下隐藏标签页
    if (!this._homeMode) {
      html += '<div class="ws-topbar-divider"></div>';
      html += '<div class="ws-tabs ws-topbar-tabs">';
      tabs.forEach(function (tab) {
        var meta = PANEL_TYPES[tab.type];
        html += '<div class="ws-tab' + (tab.id === activeId ? ' active' : '') + '" data-tab-id="' + tab.id + '" role="tab">';
        html += '<span class="tab-icon">' + ICONS[meta.icon] + '</span>';
        html += '<span class="tab-label">' + tab.title + '</span>';
        html += '<span class="tab-close" data-close-tab="' + tab.id + '" role="button" aria-label="关闭标签">' + ICONS.close + '</span>';
        html += '</div>';
      });
      html += '<button class="ws-add-tab" type="button" data-action="toggle-add-menu" title="添加标签" aria-label="添加标签">' + ICONS.plus + '</button>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  };

  WorkspaceEngine.prototype.renderExternalPageActions = function (ws) {
    if (!this.pageActionsMount) return;
    var slot = this.pageActionsMount.querySelector('#wsPageActionsSlot');
    if (!slot) return;
    var html = '';
    html += '<button class="ws-tool-btn" type="button" title="垂直分屏" data-action="split-v" aria-label="垂直分屏">' + ICONS.splitV + '</button>';
    html += '<button class="ws-tool-btn" type="button" title="水平分屏" data-action="split-h" aria-label="水平分屏">' + ICONS.splitH + '</button>';
    html += '<span data-ws-actions></span>';
    slot.innerHTML = html;
  };

  WorkspaceEngine.prototype.renderFullTopbar = function (ws, tabs, activeId) {
    var triggerName = this._homeMode ? '首页' : ws.name;
    var html = '<div class="ws-topbar" data-od-id="ws-topbar">';
    html += '<div class="ws-workspace-picker">';
    html += '<button class="ws-ws-trigger' + (this._homeMode ? ' ws-home-trigger' : '') + '" type="button" id="wsWsTrigger" aria-haspopup="true" aria-expanded="' + (this._wsMenuOpen ? 'true' : 'false') + '">';
    html += '<span class="ws-ws-trigger-name">' + triggerName + '</span>';
    html += '<svg class="ws-ws-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6l4 4 4-4"/></svg>';
    html += '</button>';
    html += this.renderWorkspaceMenu(ws);
    html += '</div>';
    // 首页模式下隐藏标签页
    if (!this._homeMode) {
      html += '<div class="ws-topbar-divider"></div>';
      html += '<div class="ws-tabs ws-topbar-tabs">';
      tabs.forEach(function (tab) {
        var meta = PANEL_TYPES[tab.type];
        html += '<div class="ws-tab' + (tab.id === activeId ? ' active' : '') + '" data-tab-id="' + tab.id + '" role="tab">';
        html += '<span class="tab-icon">' + ICONS[meta.icon] + '</span>';
        html += '<span class="tab-label">' + tab.title + '</span>';
        html += '<span class="tab-close" data-close-tab="' + tab.id + '" role="button" aria-label="关闭标签">' + ICONS.close + '</span>';
        html += '</div>';
      });
      html += '<button class="ws-add-tab" type="button" data-action="toggle-add-menu" title="添加标签" aria-label="添加标签">' + ICONS.plus + '</button>';
      html += '</div>';
    }
    html += '<div class="ws-topbar-spacer"></div>';
    html += '<div class="ws-topbar-actions">';
    html += '<button class="ws-tool-btn" type="button" title="垂直分屏" data-action="split-v" aria-label="垂直分屏">' + ICONS.splitV + '</button>';
    html += '<button class="ws-tool-btn" type="button" title="水平分屏" data-action="split-h" aria-label="水平分屏">' + ICONS.splitH + '</button>';
    if (!this.standalone) {
      html += '<button class="ws-tool-btn" type="button" title="AI 面板" data-action="toggle-ai" aria-label="切换 AI 面板"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z"/><path d="M18 14h.01M6 14h.01"/><path d="M12 17v4M8 21h8"/></svg></button>';
    }
    html += '<span data-ws-actions></span>';
    if (this.standalone) {
      html += '<button class="topbar-btn" type="button" title="通知"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg><span class="notif-badge">3</span></button>';
      html += '<button class="topbar-btn" type="button" title="搜索 (Ctrl+K)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></button>';
      html += '<div class="win-controls"><button class="win-btn close" title="关闭"></button><button class="win-btn minimize" title="最小化"></button><button class="win-btn maximize" title="最大化"></button></div>';
    }
    html += '</div></div>';
    return html;
  };

  WorkspaceEngine.prototype.renderNode = function (node, ws) {
    if (node.kind === 'pane') {
      ensureActiveTab(node);
      var activeTab = node.tabs.find(function (t) { return t.id === node.activeTabId; });
      var focused = node.id === ws.focusedPaneId;
      var html = '<div class="ws-pane' + (focused ? ' focused' : '') + '" data-pane-id="' + node.id + '">';
      html += '<div class="ws-pane-header">';
      html += '<span>' + (activeTab ? activeTab.title : '空面板') + '</span>';
      html += '<div class="pane-actions">';
      html += '<button class="pane-btn" type="button" data-action="split-v" data-pane-id="' + node.id + '" title="垂直分屏">' + ICONS.splitV + '</button>';
      html += '<button class="pane-btn" type="button" data-action="split-h" data-pane-id="' + node.id + '" title="水平分屏">' + ICONS.splitH + '</button>';
      html += '</div></div>';
      html += '<div class="ws-pane-body">';
      html += activeTab ? panelHTML(activeTab) : '<div class="panel-content text-muted" style="padding:16px;">无标签 — 点击 + 添加</div>';
      html += '</div></div>';
      return html;
    }

    var dirClass = node.direction === 'vertical' ? 'vertical' : 'horizontal';
    var ratio = node.ratio;
    var firstFlex = ratio;
    var secondFlex = 1 - ratio;
    var html = '<div class="ws-split-node ' + dirClass + '" data-split-id="' + node.id + '">';
    html += '<div style="flex:' + firstFlex + ';display:flex;min-width:0;min-height:0;">' + this.renderNode(node.first, ws) + '</div>';
    html += '<div class="ws-gutter ' + dirClass + '" data-gutter-split="' + node.id + '"></div>';
    html += '<div style="flex:' + secondFlex + ';display:flex;min-width:0;min-height:0;">' + this.renderNode(node.second, ws) + '</div>';
    html += '</div>';
    return html;
  };

  WorkspaceEngine.prototype.renderSwitcher = function () {
    var ws = this.getActiveWorkspace();
    var html = '<div class="ws-switcher">';
    html += '<div class="ws-switcher-pop' + (this._switcherOpen ? ' open' : '') + '" id="wsSwitcherPop">';
    html += '<div class="ws-switcher-pop-header">工作区</div>';
    this.workspaces.forEach(function (w) {
      var tabCount = 0;
      walkPanes(w.root, function (p) { tabCount += p.tabs.length; });
      html += '<div class="ws-switcher-item' + (w.id === ws.id ? ' active' : '') + '" data-ws-id="' + w.id + '">';
      html += '<div class="sw-icon">' + ICONS.layers + '</div>';
      html += '<div class="sw-body"><div class="sw-name">' + w.name + '</div><div class="sw-meta">' + tabCount + ' 个标签</div></div>';
      html += '</div>';
    });
    html += '<div class="ws-switcher-add" data-action="new-workspace">' + ICONS.plus + ' 新建工作区</div>';
    html += '</div>';
    html += '<button class="ws-switcher-btn" type="button" id="wsSwitcherBtn">';
    html += ICONS.layers;
    html += '<span>' + ws.name + '</span>';
    html += '<span class="ws-count">' + this.workspaces.length + '</span>';
    html += '</button></div>';
    return html;
  };

  WorkspaceEngine.prototype.renderAddMenu = function () {
    var html = '<div class="ws-add-menu' + (this._addMenuOpen ? ' open' : '') + '" id="wsAddMenu">';
    Object.keys(PANEL_TYPES).forEach(function (key) {
      var p = PANEL_TYPES[key];
      html += '<div class="ws-add-menu-item" data-add-type="' + key + '">' + ICONS[p.icon] + '<span>' + p.label + '</span></div>';
    });
    html += '</div>';
    return html;
  };

  WorkspaceEngine.prototype.bindEvents = function (ws) {
    var self = this;
    var q = function (sel) { return self._queryInRoots(sel); };

    q('[data-pane-id]').forEach(function (el) {
      el.addEventListener('mousedown', function (e) {
        if (e.target.closest('[data-action]') || e.target.closest('[data-close-tab]')) return;
        ws.focusedPaneId = el.getAttribute('data-pane-id');
        self.render();
      });
    });

    q('.ws-tab').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('[data-close-tab]')) return;
        var tabId = el.getAttribute('data-tab-id');
        var pane = findPaneById(ws.root, ws.focusedPaneId);
        if (pane) {
          pane.activeTabId = tabId;
          self.render();
        }
      });
    });

    q('[data-close-tab]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var tabId = el.getAttribute('data-close-tab');
        var pane = findPaneById(ws.root, ws.focusedPaneId);
        if (!pane || pane.tabs.length <= 1) return;
        pane.tabs = pane.tabs.filter(function (t) { return t.id !== tabId; });
        if (pane.activeTabId === tabId) {
          pane.activeTabId = pane.tabs[0].id;
        }
        self.render();
      });
    });

    q('[data-action="split-h"], [data-action="split-v"]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var dir = btn.getAttribute('data-action') === 'split-v' ? 'vertical' : 'horizontal';
        var paneId = btn.getAttribute('data-pane-id') || ws.focusedPaneId;
        self.splitPane(paneId, dir);
      });
    });

    q('[data-add-type]').forEach(function (el) {
      el.addEventListener('click', function () {
        var type = el.getAttribute('data-add-type');
        self.addTab(type);
        self._addMenuOpen = false;
        self.render();
      });
    });

    var addBtn = q('[data-action="toggle-add-menu"]')[0];
    if (addBtn) {
      addBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self._addMenuOpen = !self._addMenuOpen;
        self.render();
      });
    }

    var wsTrigger = q('#wsWsTrigger')[0];
    if (wsTrigger) {
      wsTrigger.addEventListener('click', function (e) {
        e.stopPropagation();
        self._wsMenuOpen = !self._wsMenuOpen;
        self._addMenuOpen = false;
        self.render();
      });
    }

    q('[data-ws-id]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        // If we're on the home dashboard, hide it first
        if (self._homeMode && global.__wsHostInstance) {
          global.__wsHostInstance.hideHomeDashboard();
          // Restore embed-wrap and viewport visibility
          var embedWrap = document.getElementById('wsEmbedWrap');
          if (embedWrap) embedWrap.style.display = '';
          var viewport = document.getElementById('appViewport');
          if (viewport) viewport.style.display = '';
        }
        self.activeWorkspaceId = el.getAttribute('data-ws-id');
        self._wsMenuOpen = false;
        self.render();
      });
    });

    q('[data-action="new-workspace"]').forEach(function (newWs) {
      newWs.addEventListener('click', function (e) {
        e.stopPropagation();
        var n = self.workspaces.length + 1;
        var w = defaultWorkspace('工作区 ' + n);
        self.workspaces.push(w);
        self.activeWorkspaceId = w.id;
        self._wsMenuOpen = false;
        self.render();
      });
    });

    q('[data-action="show-home"]').forEach(function (homeBtn) {
      homeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        self._wsMenuOpen = false;
        self.render();
        // Trigger host to go home (full-screen workspace + dashboard)
        if (global.__wsHostInstance && typeof global.__wsHostInstance.goHome === 'function') {
          global.__wsHostInstance.goHome();
        }
      });
    });

    var aiBtn = q('[data-action="toggle-ai"]')[0];
    if (aiBtn) {
      aiBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof global.toggleAiPanel === 'function') global.toggleAiPanel();
      });
    }

    q('[data-gutter-split]').forEach(function (gutter) {
      gutter.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var splitId = gutter.getAttribute('data-gutter-split');
        self.startDrag(splitId, e);
      });
    });

    this._getEventRoots().forEach(function (root) {
      if (!root) return;
      root.addEventListener('click', function (e) {
        e.stopPropagation();
      });
    });
  };

  WorkspaceEngine.prototype._positionDropdowns = function () {
    var self = this;
    // Position workspace dropdown
    this._queryInRoots('.ws-ws-dropdown.open').forEach(function (dd) {
      var trigger = self._queryInRoots('#wsWsTrigger')[0];
      if (!trigger) return;
      var rect = trigger.getBoundingClientRect();
      dd.style.top = (rect.bottom + 2) + 'px';
      dd.style.left = rect.left + 'px';
    });
    // Position add-menu dropdown
    this._queryInRoots('.ws-add-menu.open').forEach(function (menu) {
      var btn = self._queryInRoots('[data-action="toggle-add-menu"]')[0];
      if (!btn) return;
      var rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + 2) + 'px';
      menu.style.left = rect.left + 'px';
    });
  };

  WorkspaceEngine.prototype.bindGlobalClose = function () {
    var self = this;
    if (this._globalBound) return;
    this._globalBound = true;
    document.addEventListener('click', function () {
      if (self._addMenuOpen || self._wsMenuOpen) {
        self._addMenuOpen = false;
        self._wsMenuOpen = false;
        self.render();
      }
    });
    window.addEventListener('resize', function () {
      if (self._addMenuOpen || self._wsMenuOpen) {
        self._positionDropdowns();
      }
    });
  };

  WorkspaceEngine.prototype.splitPane = function (paneId, direction) {
    var ws = this.getActiveWorkspace();
    var self = this;

    function replaceNode(node) {
      if (node.kind === 'pane' && node.id === paneId) {
        var activeTab = node.tabs.find(function (t) { return t.id === node.activeTabId; });
        var newPane = createPane([createTab(activeTab ? activeTab.type : 'terminal', (activeTab ? activeTab.title : '新面板') + ' · 分屏')]);
        ensureActiveTab(newPane);
        var clonePane = createPane(node.tabs.slice(), node.activeTabId);
        ensureActiveTab(clonePane);
        var split = createSplit(direction, clonePane, newPane, 0.55);
        ws.focusedPaneId = newPane.id;
        return split;
      }
      if (node.kind === 'split') {
        return createSplit(node.direction, replaceNode(node.first) || node.first, replaceNode(node.second) || node.second, node.ratio);
      }
      return null;
    }

    var replaced = replaceNode(ws.root);
    if (replaced) ws.root = replaced;
    this.render();
  };

  WorkspaceEngine.prototype.addTab = function (type) {
    var ws = this.getActiveWorkspace();
    var pane = findPaneById(ws.root, ws.focusedPaneId);
    if (!pane && ws.root.kind === 'pane') pane = ws.root;
    if (!pane) return;
    var tab = createTab(type);
    pane.tabs.push(tab);
    pane.activeTabId = tab.id;
  };

  WorkspaceEngine.prototype.startDrag = function (splitId, e) {
    var self = this;
    var ws = this.getActiveWorkspace();

    function findSplit(node) {
      if (node.kind === 'split' && node.id === splitId) return node;
      if (node.kind === 'split') return findSplit(node.first) || findSplit(node.second);
      return null;
    }

    var split = findSplit(ws.root);
    if (!split) return;

    var gutter = self.mountEl.querySelector('[data-gutter-split="' + splitId + '"]');
    var container = gutter.parentElement;
    var isHoriz = split.direction === 'horizontal';

    self._drag = { split: split, isHoriz: isHoriz, container: container };
    gutter.classList.add('dragging');

    function onMove(ev) {
      var rect = container.getBoundingClientRect();
      var ratio;
      if (isHoriz) {
        ratio = (ev.clientX - rect.left) / rect.width;
      } else {
        ratio = (ev.clientY - rect.top) / rect.height;
      }
      split.ratio = Math.min(0.85, Math.max(0.15, ratio));
      self.render();
      var g = self.mountEl.querySelector('[data-gutter-split="' + splitId + '"]');
      if (g) g.classList.add('dragging');
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      self._drag = null;
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  WorkspaceEngine.prototype.initPreset = function (preset) {
    var ws = this.getActiveWorkspace();
    if (preset === 'nested') {
      var left = createPane([createTab('terminal', 'ssh prod-web-01'), createTab('logs', 'nginx')]);
      ensureActiveTab(left);
      var rightTop = createPane([createTab('sql', 'prod-db')]);
      ensureActiveTab(rightTop);
      var rightBottom = createPane([createTab('docker', 'compose'), createTab('knowledge', 'Runbook')]);
      ensureActiveTab(rightBottom);
      var rightSplit = createSplit('vertical', rightTop, rightBottom, 0.45);
      ws.root = createSplit('horizontal', left, rightSplit, 0.52);
      ws.focusedPaneId = left.id;
    }
  };

  global.WorkspaceEngine = WorkspaceEngine;
  global.WorkspaceIcons = ICONS;
})(window);
