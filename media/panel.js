(function () {
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('accounts');
  const empty = document.getElementById('empty');
  const unsaved = document.getElementById('unsaved');
  const warning = document.getElementById('warning');
  const home = document.getElementById('home');

  /** Usage above this counts as spent; the panel shows what is left, so it flips. */
  let warnThreshold = 80;

  function post(type, id) {
    vscode.postMessage({ type, id });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  /** Compact duration from now: "3d 10h", "1h 10m", "12m". */
  function until(unixSeconds) {
    if (!unixSeconds) {
      return null;
    }
    const seconds = unixSeconds - Math.floor(Date.now() / 1000);
    if (seconds <= 0) {
      return 'any moment';
    }
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) {
      return `${days}d ${hours}h`;
    }
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  }

  function ago(timestampMs) {
    if (!timestampMs) {
      return 'never checked';
    }
    const minutes = Math.floor((Date.now() - timestampMs) / 60000);
    if (minutes < 1) {
      return 'just now';
    }
    if (minutes < 60) {
      return `${minutes} min ago`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  }

  const freeOf = (window) => 100 - window.usedPercent;

  /** Severity from what is left, not what was spent. */
  function severity(free) {
    if (free === null) {
      return 'unknown';
    }
    if (free <= 0) {
      return 'out';
    }
    return free <= 100 - warnThreshold ? 'low' : 'ok';
  }

  /**
   * The session and the weekly window gate every request, so they drive the
   * headline. Per-model windows only gate that model and are listed below.
   */
  function accountWindows(usage) {
    if (!usage || !usage.windows) {
      return [];
    }
    return usage.windows.filter((window) => window.kind === 'session' || window.kind === 'weekly');
  }

  /** How much room is left on the tightest account-wide window. */
  function runway(profile) {
    const windows = accountWindows(profile.lastUsage);
    return windows.length === 0 ? null : Math.min(...windows.map(freeOf));
  }

  function track(level, usedPercent) {
    const node = el('div', `track ${level}`);
    const fill = el('span');
    fill.style.width = `${Math.min(100, Math.max(0, usedPercent))}%`;
    node.append(fill);
    return node;
  }

  function windowRow(window) {
    const row = el('li');
    const label = el('span', 'w', window.label);
    label.title = window.label;
    row.append(label);
    const free = freeOf(window);
    const reset = until(window.resetsAt);
    let text;
    if (window.usedPercent === 0) {
      text = 'untouched';
    } else if (free <= 0) {
      text = reset ? `spent · back in ${reset}` : 'spent';
    } else {
      text = reset ? `${window.usedPercent}% used · resets ${reset}` : `${window.usedPercent}% used`;
    }
    row.append(el('span', free <= 0 ? 'v exhausted' : 'v', text));
    row.append(track(severity(free), window.usedPercent));
    return row;
  }

  function windowList(windows, className) {
    const ul = el('ul', className);
    for (const window of windows) {
      ul.append(windowRow(window));
    }
    return ul;
  }

  function button(label, action, id, title, className) {
    const node = el('button', className);
    // The label lives in a span so the busy state can spin the glyph alone.
    node.append(el('span', null, label));
    node.title = title || label;
    node.addEventListener('click', () => post(action, id));
    return node;
  }

  function accountNode(profile, busy) {
    const node = el('article', profile.active ? 'account active' : 'account');

    const free = runway(profile);
    const level = severity(free);

    const head = el('div', 'account-head');
    head.append(el('span', 'name', profile.label));
    if (profile.active) {
      head.append(el('span', 'active-tag', 'in use'));
    }
    head.append(el('span', 'spacer'));
    head.append(el('span', `figure ${level}`, free === null ? '—' : `${100 - free}%`));
    if (free !== null) {
      head.append(el('span', 'figure-label', 'used'));
    }
    node.append(head);

    const meta = [profile.email, profile.planType && profile.planType.toUpperCase()].filter(Boolean);
    if (meta.length > 0) {
      const line = el('div', 'meta-line', meta.join(' · '));
      if (profile.organizationName) {
        line.title = profile.organizationName;
      }
      node.append(line);
    }

    // Each window carries its own bar below, so the card no longer has a single
    // bar for the tightest one — it would repeat whichever window that is.
    const usage = profile.lastUsage;
    const main = accountWindows(usage);
    if (main.length > 0) {
      node.append(windowList(main, 'windows'));
    }
    const scoped = usage && usage.windows ? usage.windows.filter((window) => !main.includes(window)) : [];
    if (scoped.length > 0) {
      node.append(el('div', 'family', 'per model'));
      node.append(windowList(scoped, 'windows sub'));
    }
    if (usage && usage.extraUsage && usage.extraUsage.enabled) {
      const extra = usage.extraUsage;
      const text = extra.spendLimitReached
        ? 'extra usage: spend limit reached'
        : `extra usage on${extra.utilization !== null ? ` · ${extra.utilization}% of monthly limit` : ''}`;
      node.append(el('div', 'note', text));
    }

    const broken = !busy && usage && usage.errorKind === 'auth';
    if (busy) {
      node.append(el('div', 'note', 'checking…'));
    } else if (usage && usage.error) {
      const text = usage.stale ? `${usage.error} Showing the reading from ${ago(usage.fetchedAt)}.` : usage.error;
      const note = el('div', usage.stale ? 'note stale' : 'note error', text);
      if (usage.errorDetail) {
        note.title = usage.errorDetail;
      }
      node.append(note);
    } else {
      node.append(el('div', 'note', usage ? `checked ${ago(usage.fetchedAt)}` : 'never checked'));
    }

    const actions = el('div', 'actions');
    if (broken) {
      // Switching to a dead credential would sign Claude Code out, so the card
      // offers the repair instead.
      actions.append(button('Log in', 'login', profile.id, 'Sign in to this account again', 'use'));
    } else if (!profile.active) {
      actions.append(button('Use', 'switch', profile.id, 'Make this the active account', 'use'));
    }
    actions.append(el('span', 'grow'));
    const check = button('↻', 'refreshOne', profile.id, 'Check this account now');
    if (busy) {
      check.classList.add('busy');
      check.disabled = true;
    }
    actions.append(check);
    actions.append(button('✎', 'rename', profile.id, 'Rename'));
    actions.append(button('\u{1F5D1}', 'remove', profile.id, 'Remove', 'danger'));
    node.append(actions);

    return node;
  }

  function render(state) {
    warnThreshold = state.warnThreshold || 80;

    // The account in use is pinned to the top: it is the one being spent.
    // Everything below is most room first, so the account to switch to is the
    // next one down; accounts with no reading sink rather than posing as full.
    const ordered = [...state.profiles].sort((a, b) => {
      if (a.active !== b.active) {
        return a.active ? -1 : 1;
      }
      const left = runway(a);
      const right = runway(b);
      if (left === right) {
        return a.order - b.order;
      }
      if (left === null) {
        return 1;
      }
      if (right === null) {
        return -1;
      }
      return right - left;
    });

    const busy = new Set(state.pending || []);
    list.replaceChildren(...ordered.map((profile) => accountNode(profile, busy.has(profile.id))));
    empty.hidden = ordered.length > 0;

    if (state.unsaved) {
      unsaved.textContent = `${state.unsaved.email || 'An account'} is signed in but not saved here. Save it before switching, or it is gone.`;
      unsaved.hidden = false;
    } else {
      unsaved.hidden = true;
    }

    warning.textContent = state.warning || '';
    warning.hidden = !state.warning;

    home.textContent = state.location;

    const refreshAll = document.querySelector('.toolbar button[data-action="refreshAll"]');
    refreshAll.disabled = state.refreshing;
    refreshAll.classList.toggle('busy', state.refreshing);
  }

  for (const node of document.querySelectorAll('.toolbar button')) {
    node.addEventListener('click', () => post(node.dataset.action));
  }

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'state') {
      render(event.data);
    }
  });

  post('ready');
})();
